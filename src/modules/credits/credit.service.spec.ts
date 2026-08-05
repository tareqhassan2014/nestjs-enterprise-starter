import { EventEmitter2 } from '@nestjs/event-emitter';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import {
  organizationSubject,
  userSubject,
} from '@modules/organizations/billing-subject';

import { CREDITS_LOW_BALANCE_EVENT, CreditService } from './credit.service';

interface WalletRow {
  id: string;
  userId: string | null;
  organizationId: string | null;
  balance: number;
}

type LedgerRow = {
  id: string;
  userId: string | null;
  organizationId: string | null;
  type: string;
  amount: number;
  balanceAfter: number;
  feature: string | null;
  idempotencyKey: string;
  metadata: unknown;
  createdAt: Date;
};

type WalletOwnerWhere = { userId: string } | { organizationId: string };

function ownerKey(where: WalletOwnerWhere): string {
  return 'userId' in where ? `u:${where.userId}` : `o:${where.organizationId}`;
}

function createService(options?: { lowBalanceThreshold?: number }): {
  service: CreditService;
  events: { emit: jest.Mock };
  state: {
    wallets: Map<string, WalletRow>;
    ledger: Map<string, LedgerRow>;
  };
} {
  const wallets = new Map<string, WalletRow>();
  const ledger = new Map<string, LedgerRow>();
  let walletSeq = 0;
  let entrySeq = 0;

  const tx = {
    creditLedgerEntry: {
      findUnique: jest.fn(
        ({ where }: { where: { idempotencyKey: string } }) =>
          ledger.get(where.idempotencyKey) ?? null,
      ),
      create: jest.fn(
        ({ data }: { data: Omit<LedgerRow, 'id' | 'createdAt'> }) => {
          const row: LedgerRow = {
            id: `entry-${++entrySeq}`,
            createdAt: new Date(),
            userId: data.userId ?? null,
            organizationId: data.organizationId ?? null,
            type: data.type,
            amount: data.amount,
            balanceAfter: data.balanceAfter,
            feature: data.feature ?? null,
            idempotencyKey: data.idempotencyKey,
            metadata: data.metadata ?? null,
          };
          ledger.set(row.idempotencyKey, row);
          return row;
        },
      ),
    },
    creditWallet: {
      upsert: jest.fn(
        ({
          where,
          create,
        }: {
          where: WalletOwnerWhere;
          create: { userId?: string; organizationId?: string; balance: number };
        }) => {
          const key = ownerKey(where);
          const existing = [...wallets.values()].find(
            (w) => ownerKey(walletOwnerOf(w)) === key,
          );
          if (existing) {
            return existing;
          }
          const row: WalletRow = {
            id: `wallet-${++walletSeq}`,
            userId: create.userId ?? null,
            organizationId: create.organizationId ?? null,
            balance: create.balance,
          };
          wallets.set(row.id, row);
          return row;
        },
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: WalletOwnerWhere }) => {
        const key = ownerKey(where);
        const found = [...wallets.values()].find(
          (w) => ownerKey(walletOwnerOf(w)) === key,
        );
        if (!found) {
          throw new Error('missing wallet');
        }
        return found;
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { balance: number };
        }) => {
          const row = wallets.get(where.id);
          if (!row) {
            throw new Error('missing wallet');
          }
          row.balance = data.balance;
          return row;
        },
      ),
      findUnique: jest.fn(({ where }: { where: WalletOwnerWhere }) => {
        const key = ownerKey(where);
        return (
          [...wallets.values()].find(
            (w) => ownerKey(walletOwnerOf(w)) === key,
          ) ?? null
        );
      }),
    },
    $executeRaw: jest.fn(() => 1),
  };

  function walletOwnerOf(wallet: WalletRow): WalletOwnerWhere {
    return wallet.organizationId
      ? { organizationId: wallet.organizationId }
      : { userId: wallet.userId! };
  }

  const prisma = {
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
    creditWallet: tx.creditWallet,
    creditLedgerEntry: {
      findMany: jest.fn(),
    },
  };

  const events = { emit: jest.fn() };

  const service = new CreditService(
    prisma as never,
    events as unknown as EventEmitter2,
    { lowBalanceThreshold: options?.lowBalanceThreshold },
  );

  return { service, events, state: { wallets, ledger } };
}

describe('CreditService', () => {
  it('grants, spends, refunds, and adjusts with ledger entries (bare userId)', async () => {
    const { service, state } = createService();

    await service.grant({ userId: 'u1', amount: 10, idempotencyKey: 'g1' });
    expect(state.wallets.get('wallet-1')?.balance).toBe(10);

    await service.spend({
      userId: 'u1',
      amount: 3,
      idempotencyKey: 's1',
      feature: 'demo.paid',
    });
    expect(state.wallets.get('wallet-1')?.balance).toBe(7);

    await service.refund({
      userId: 'u1',
      amount: 1,
      idempotencyKey: 'r1',
      feature: 'demo.paid',
    });
    expect(state.wallets.get('wallet-1')?.balance).toBe(8);

    await service.adjust({ userId: 'u1', delta: -2, idempotencyKey: 'a1' });
    expect(state.wallets.get('wallet-1')?.balance).toBe(6);

    expect(state.ledger.size).toBe(4);
  });

  it('replays the same idempotency key without double-applying', async () => {
    const { service, state } = createService();

    await service.grant({ userId: 'u1', amount: 5, idempotencyKey: 'same' });
    const second = await service.grant({
      userId: 'u1',
      amount: 5,
      idempotencyKey: 'same',
    });

    expect(second.replayed).toBe(true);
    expect(state.wallets.get('wallet-1')?.balance).toBe(5);
    expect(state.ledger.size).toBe(1);
  });

  it('rejects conflicting idempotency reuse', async () => {
    const { service } = createService();
    await service.grant({ userId: 'u1', amount: 5, idempotencyKey: 'k' });

    await expect(
      service.grant({ userId: 'u1', amount: 9, idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  /**
   * Direction, which idempotency validation used to be blind to.
   *
   * `adjust` stores `amount: Math.abs(delta)` with `type: 'adjust'`, so `+50` and
   * `-50` produced identical comparison inputs — and the admin route takes the
   * idempotency key from the request body, so an operator reusing a ticket id got
   * the opposite adjustment reported as a successful replay while the balance never
   * moved.
   */
  it('rejects an opposite-direction adjust reusing an idempotency key', async () => {
    const { service, state } = createService();
    await service.grant({ userId: 'u1', amount: 100, idempotencyKey: 'g' });
    await service.adjust({ userId: 'u1', delta: 50, idempotencyKey: 'op-1' });

    expect(state.wallets.get('wallet-1')?.balance).toBe(150);

    await expect(
      service.adjust({ userId: 'u1', delta: -50, idempotencyKey: 'op-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

    // And the balance is untouched by the rejected call.
    expect(state.wallets.get('wallet-1')?.balance).toBe(150);
  });

  it('still treats an identical adjust replay as a no-op success', async () => {
    const { service, state } = createService();
    await service.grant({ userId: 'u1', amount: 100, idempotencyKey: 'g' });
    await service.adjust({ userId: 'u1', delta: -25, idempotencyKey: 'op-2' });

    const replay = await service.adjust({
      userId: 'u1',
      delta: -25,
      idempotencyKey: 'op-2',
    });

    expect(replay.replayed).toBe(true);
    expect(state.wallets.get('wallet-1')?.balance).toBe(75);
    expect(state.ledger.size).toBe(2);
  });

  /**
   * Adjust entries written before this change carry no recorded delta, so their
   * direction cannot be verified. Those must fall back to the previous comparison
   * rather than reject — refusing every pre-existing adjust key would turn a
   * hardening change into an outage. A real, bounded coverage gap.
   */
  it('falls back rather than rejecting when a legacy adjust has no recorded delta', async () => {
    const { service, state } = createService();
    await service.grant({ userId: 'u1', amount: 100, idempotencyKey: 'g' });
    await service.adjust({ userId: 'u1', delta: 40, idempotencyKey: 'legacy' });

    // Simulate a row written before the signed delta was persisted.
    const entry = [...state.ledger.values()].find(
      (row) => row.idempotencyKey === 'legacy',
    );
    expect(entry).toBeDefined();
    entry!.metadata = null;

    const replay = await service.adjust({
      userId: 'u1',
      delta: 40,
      idempotencyKey: 'legacy',
    });

    expect(replay.replayed).toBe(true);
    expect(state.wallets.get('wallet-1')?.balance).toBe(140);
  });

  it('emits low-balance when a negative adjust crosses the threshold', async () => {
    const { service, events } = createService({ lowBalanceThreshold: 2 });
    await service.grant({ userId: 'u1', amount: 10, idempotencyKey: 'g' });

    await service.adjust({ userId: 'u1', delta: -9, idempotencyKey: 'a' });

    /**
     * Previously gated on `type === 'spend'`, so an operator debiting a wallet
     * below the threshold emitted nothing — the customer was stranded with nobody
     * warned.
     */
    expect(events.emit).toHaveBeenCalledWith(
      CREDITS_LOW_BALANCE_EVENT,
      expect.objectContaining({ balance: 1, threshold: 2 }),
    );
  });

  it('does not emit low-balance for a credit that leaves a low balance', async () => {
    const { service, events } = createService({ lowBalanceThreshold: 5 });

    // Ends at 1, below the threshold, but the balance moved upward.
    await service.grant({ userId: 'u1', amount: 1, idempotencyKey: 'g' });
    await service.refund({ userId: 'u1', amount: 0 + 1, idempotencyKey: 'r' });

    expect(events.emit).not.toHaveBeenCalledWith(
      CREDITS_LOW_BALANCE_EVENT,
      expect.anything(),
    );
  });

  it('fails spend when balance is insufficient', async () => {
    const { service, state } = createService();
    await service.grant({ userId: 'u1', amount: 1, idempotencyKey: 'g' });

    await expect(
      service.spend({
        userId: 'u1',
        amount: 5,
        idempotencyKey: 's',
        feature: 'demo.paid',
      }),
    ).rejects.toBeInstanceOf(ApiException);

    expect(state.wallets.get('wallet-1')?.balance).toBe(1);
    expect(state.ledger.size).toBe(1);
  });

  it('emits low-balance with a user subject when threshold is crossed', async () => {
    const { service, events } = createService({ lowBalanceThreshold: 2 });
    await service.grant({ userId: 'u1', amount: 3, idempotencyKey: 'g' });
    await service.spend({
      userId: 'u1',
      amount: 2,
      idempotencyKey: 's',
      feature: 'demo.paid',
    });

    expect(events.emit).toHaveBeenCalledWith(
      CREDITS_LOW_BALANCE_EVENT,
      expect.objectContaining({
        subject: userSubject('u1'),
        userId: 'u1',
        balance: 1,
        threshold: 2,
      }),
    );
  });

  it('does not emit low-balance when threshold is absent', async () => {
    const { service, events } = createService();
    await service.grant({ userId: 'u1', amount: 1, idempotencyKey: 'g' });
    await service.spend({
      userId: 'u1',
      amount: 1,
      idempotencyKey: 's',
      feature: 'demo.paid',
    });

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('operates on an organization wallet when given an organization subject', async () => {
    const { service, state } = createService();
    const subject = organizationSubject('org-1');

    await service.grant({ subject, amount: 20, idempotencyKey: 'og' });
    await service.spend({
      subject,
      amount: 5,
      idempotencyKey: 'os',
      feature: 'demo.paid',
    });

    const wallet = [...state.wallets.values()].find(
      (w) => w.organizationId === 'org-1',
    );
    expect(wallet?.balance).toBe(15);
    expect(wallet?.userId).toBeNull();
  });

  it('keeps user and organization wallets independent', async () => {
    const { service, state } = createService();

    await service.grant({ userId: 'u1', amount: 10, idempotencyKey: 'g-user' });
    await service.grant({
      subject: organizationSubject('org-1'),
      amount: 30,
      idempotencyKey: 'g-org',
    });

    expect(await service.getBalance('u1')).toBe(10);
    expect(await service.getBalance(organizationSubject('org-1'))).toBe(30);
    expect(state.wallets.size).toBe(2);
  });

  it('emits low-balance with an organization subject and no userId', async () => {
    const { service, events } = createService({ lowBalanceThreshold: 5 });
    const subject = organizationSubject('org-1');
    await service.grant({ subject, amount: 10, idempotencyKey: 'og' });

    await service.spend({
      subject,
      amount: 6,
      idempotencyKey: 'os',
      feature: 'demo.paid',
    });

    expect(events.emit).toHaveBeenCalledWith(
      CREDITS_LOW_BALANCE_EVENT,
      expect.objectContaining({
        subject,
        userId: undefined,
        balance: 4,
        threshold: 5,
      }),
    );
  });

  it('throws when neither a subject nor a userId is supplied', async () => {
    const { service } = createService();

    await expect(
      service.grant({ amount: 1, idempotencyKey: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });
});
