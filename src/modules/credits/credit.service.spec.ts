import { EventEmitter2 } from '@nestjs/event-emitter';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

import {
  CREDITS_LOW_BALANCE_EVENT,
  CreditService,
} from './credit.service';

type LedgerRow = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  feature: string | null;
  idempotencyKey: string;
  metadata: unknown;
  createdAt: Date;
};

function createService(options?: {
  lowBalanceThreshold?: number;
}): {
  service: CreditService;
  events: { emit: jest.Mock };
  state: {
    wallets: Map<string, number>;
    ledger: Map<string, LedgerRow>;
  };
} {
  const wallets = new Map<string, number>();
  const ledger = new Map<string, LedgerRow>();
  let idSeq = 0;

  const tx = {
    creditLedgerEntry: {
      findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
        ledger.get(where.idempotencyKey) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<LedgerRow, 'id' | 'createdAt'> }) => {
        const row: LedgerRow = {
          id: `entry-${++idSeq}`,
          createdAt: new Date(),
          ...data,
          feature: data.feature ?? null,
          metadata: data.metadata ?? null,
        };
        ledger.set(row.idempotencyKey, row);
        return row;
      }),
    },
    creditWallet: {
      upsert: jest.fn(async ({ where }: { where: { userId: string } }) => {
        if (!wallets.has(where.userId)) {
          wallets.set(where.userId, 0);
        }
        return { userId: where.userId, balance: wallets.get(where.userId)! };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { userId: string } }) => {
        if (!wallets.has(where.userId)) {
          throw new Error('missing wallet');
        }
        return { userId: where.userId, balance: wallets.get(where.userId)! };
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { userId: string };
          data: { balance: number };
        }) => {
          wallets.set(where.userId, data.balance);
          return { userId: where.userId, balance: data.balance };
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => {
        if (!wallets.has(where.userId)) {
          return null;
        }
        return { userId: where.userId, balance: wallets.get(where.userId)! };
      }),
    },
    $executeRaw: jest.fn(async () => 1),
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
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
    { lowBalanceThreshold: options?.lowBalanceThreshold } as never,
  );

  return { service, events, state: { wallets, ledger } };
}

describe('CreditService', () => {
  it('grants, spends, refunds, and adjusts with ledger entries', async () => {
    const { service, state } = createService();

    await service.grant({
      userId: 'u1',
      amount: 10,
      idempotencyKey: 'g1',
    });
    expect(state.wallets.get('u1')).toBe(10);

    await service.spend({
      userId: 'u1',
      amount: 3,
      idempotencyKey: 's1',
      feature: 'demo.paid',
    });
    expect(state.wallets.get('u1')).toBe(7);

    await service.refund({
      userId: 'u1',
      amount: 1,
      idempotencyKey: 'r1',
      feature: 'demo.paid',
    });
    expect(state.wallets.get('u1')).toBe(8);

    await service.adjust({
      userId: 'u1',
      delta: -2,
      idempotencyKey: 'a1',
    });
    expect(state.wallets.get('u1')).toBe(6);

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
    expect(state.wallets.get('u1')).toBe(5);
    expect(state.ledger.size).toBe(1);
  });

  it('rejects conflicting idempotency reuse', async () => {
    const { service } = createService();
    await service.grant({ userId: 'u1', amount: 5, idempotencyKey: 'k' });

    await expect(
      service.grant({ userId: 'u1', amount: 9, idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
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

    expect(state.wallets.get('u1')).toBe(1);
    expect(state.ledger.size).toBe(1);
  });

  it('emits low-balance when threshold is crossed', async () => {
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
      expect.objectContaining({ userId: 'u1', balance: 1, threshold: 2 }),
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
});
