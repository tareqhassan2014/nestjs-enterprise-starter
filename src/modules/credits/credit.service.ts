import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreditLedgerEntry, Prisma } from '@/generated/prisma/client';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { creditsConfig } from '@config/credits.config';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { MetricsService } from '@modules/metrics/metrics.service';
import {
  type BillingSubject,
  userSubject,
} from '@modules/organizations/billing-subject';

export const CREDITS_LOW_BALANCE_EVENT = 'credits.low_balance';

/**
 * Metadata field carrying an adjust's signed delta, so a replay can tell a credit
 * from a debit of the same size. See `metadataWithDelta`.
 */
const ADJUST_DELTA_KEY = 'adjustDelta';

export interface CreditsLowBalancePayload {
  subject: BillingSubject;
  /**
   * Present only for user subjects; mirrors `subject.userId`. Kept for
   * listeners written before organizations existed — prefer `subject`.
   */
  userId?: string;
  balance: number;
  threshold: number;
}

export interface CreditMutationResult {
  entry: CreditLedgerEntry;
  balance: number;
  replayed: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * Accepted on every mutation/read method: a resolved `BillingSubject`, or —
 * for every caller written before organizations existed — a bare `userId`.
 * Exactly one must be supplied; `resolveSubject` throws otherwise.
 */
interface SubjectInput {
  subject?: BillingSubject;
  userId?: string;
}

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @Inject(creditsConfig.KEY)
    private readonly credits: ConfigType<typeof creditsConfig>,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async getBalance(subject: BillingSubject | string): Promise<number> {
    const resolved = this.toSubject(subject);
    const wallet = await this.prisma.creditWallet.findUnique({
      where: this.ownerWhere(resolved),
    });
    return wallet?.balance ?? 0;
  }

  async listLedger(
    subject: BillingSubject | string,
    limit = 20,
  ): Promise<CreditLedgerEntry[]> {
    const resolved = this.toSubject(subject);
    const take = Math.min(Math.max(limit, 1), 100);
    return this.prisma.creditLedgerEntry.findMany({
      where: this.ownerData(resolved),
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async grant(
    params: SubjectInput & {
      amount: number;
      idempotencyKey: string;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<CreditMutationResult> {
    this.assertPositiveAmount(params.amount);
    return this.apply({
      subject: this.resolveSubject(params),
      type: 'grant',
      amount: params.amount,
      delta: params.amount,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
    });
  }

  async spend(
    params: SubjectInput & {
      amount: number;
      idempotencyKey: string;
      feature?: string;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<CreditMutationResult> {
    this.assertPositiveAmount(params.amount);
    return this.apply({
      subject: this.resolveSubject(params),
      type: 'spend',
      amount: params.amount,
      delta: -params.amount,
      idempotencyKey: params.idempotencyKey,
      feature: params.feature,
      metadata: params.metadata,
      failIfInsufficient: true,
    });
  }

  async refund(
    params: SubjectInput & {
      amount: number;
      idempotencyKey: string;
      feature?: string;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<CreditMutationResult> {
    this.assertPositiveAmount(params.amount);
    return this.apply({
      subject: this.resolveSubject(params),
      type: 'refund',
      amount: params.amount,
      delta: params.amount,
      idempotencyKey: params.idempotencyKey,
      feature: params.feature,
      metadata: params.metadata,
    });
  }

  /**
   * Signed delta adjust. Positive credits the wallet; negative debits it.
   * Stored amount is absolute; type is always `adjust`.
   */
  async adjust(
    params: SubjectInput & {
      delta: number;
      idempotencyKey: string;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<CreditMutationResult> {
    if (!Number.isInteger(params.delta) || params.delta === 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Adjust delta must be a non-zero integer.',
      );
    }

    return this.apply({
      subject: this.resolveSubject(params),
      type: 'adjust',
      amount: Math.abs(params.delta),
      delta: params.delta,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
      failIfInsufficient: params.delta < 0,
    });
  }

  private async apply(params: {
    subject: BillingSubject;
    type: 'grant' | 'spend' | 'refund' | 'adjust';
    amount: number;
    delta: number;
    idempotencyKey: string;
    feature?: string;
    metadata?: Prisma.InputJsonValue;
    failIfInsufficient?: boolean;
  }): Promise<CreditMutationResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.creditLedgerEntry.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });

      if (existing) {
        this.assertReplayMatches(existing, params);
        return {
          entry: existing,
          balance: existing.balanceAfter,
          replayed: true,
        };
      }

      // Create first so FOR UPDATE has a row; then lock for concurrent spends.
      await this.ensureWallet(tx, params.subject);
      await this.lockWallet(tx, params.subject);
      const wallet = await tx.creditWallet.findUniqueOrThrow({
        where: this.ownerWhere(params.subject),
      });
      const nextBalance = wallet.balance + params.delta;

      if (params.failIfInsufficient && nextBalance < 0) {
        throw new ApiException(
          HttpStatus.PAYMENT_REQUIRED,
          ErrorCode.INSUFFICIENT_CREDITS,
          'Insufficient credits.',
          {
            required: params.amount,
            balance: wallet.balance,
            feature: params.feature,
          },
        );
      }

      const updated = await tx.creditWallet.update({
        where: { id: wallet.id },
        data: { balance: nextBalance },
      });

      const entry = await tx.creditLedgerEntry.create({
        data: {
          ...this.ownerData(params.subject),
          type: params.type,
          amount: params.amount,
          balanceAfter: updated.balance,
          feature: params.feature,
          idempotencyKey: params.idempotencyKey,
          metadata: this.metadataWithDelta(params),
        },
      });

      return { entry, balance: updated.balance, replayed: false };
    });

    if (!result.replayed) {
      this.metrics?.recordCreditMutation(params.type);
    }

    if (
      !result.replayed &&
      params.delta < 0 &&
      this.shouldEmitLowBalance(result.balance)
    ) {
      this.emitLowBalance(params.subject, result.balance);
    }

    return result;
  }

  /**
   * Whether the resulting balance warrants a low-balance signal.
   *
   * The caller tests `delta < 0` rather than `type === 'spend'`, which is what it
   * used to do. A negative `adjust` strands a customer exactly as a metered spend
   * would, and which internal operation caused the drop is not what the warning is
   * about — so any debit qualifies. Expressed as the delta's direction rather than
   * an enumeration of types, so a mutation type added later is covered by default,
   * while a `grant` or `refund` that happens to leave a low balance stays silent
   * because the balance moved upward.
   *
   * Consequence worth knowing: the `email` bridge now fires for admin debits too.
   * That is the intent, but it does widen how often that queue job is produced.
   */
  private shouldEmitLowBalance(balance: number): boolean {
    const threshold = this.credits.lowBalanceThreshold;
    return threshold !== undefined && balance <= threshold;
  }

  private emitLowBalance(subject: BillingSubject, balance: number): void {
    const threshold = this.credits.lowBalanceThreshold!;
    const payload: CreditsLowBalancePayload = {
      subject,
      userId: subject.type === 'user' ? subject.userId : undefined,
      balance,
      threshold,
    };

    this.logger.warn({
      msg: 'Credit balance at or below threshold',
      subject,
      balance,
      threshold,
    });

    this.events.emit(CREDITS_LOW_BALANCE_EVENT, payload);
  }

  private async lockWallet(tx: Tx, subject: BillingSubject): Promise<void> {
    if (subject.type === 'organization') {
      await tx.$executeRaw`
        SELECT 1 FROM credit_wallets WHERE "organizationId" = ${subject.organizationId} FOR UPDATE
      `;
    } else {
      await tx.$executeRaw`
        SELECT 1 FROM credit_wallets WHERE "userId" = ${subject.userId} FOR UPDATE
      `;
    }
  }

  private async ensureWallet(tx: Tx, subject: BillingSubject): Promise<void> {
    await tx.creditWallet.upsert({
      where: this.ownerWhere(subject),
      create: { ...this.ownerData(subject), balance: 0 },
      update: {},
    });
  }

  private resolveSubject(params: SubjectInput): BillingSubject {
    if (params.subject) {
      return params.subject;
    }
    if (params.userId) {
      return userSubject(params.userId);
    }
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.BAD_REQUEST,
      'A billing subject (userId or organizationId) is required.',
    );
  }

  private toSubject(subject: BillingSubject | string): BillingSubject {
    return typeof subject === 'string' ? userSubject(subject) : subject;
  }

  private ownerWhere(
    subject: BillingSubject,
  ): { userId: string } | { organizationId: string } {
    return subject.type === 'organization'
      ? { organizationId: subject.organizationId }
      : { userId: subject.userId };
  }

  private ownerData(
    subject: BillingSubject,
  ): { userId: string } | { organizationId: string } {
    return this.ownerWhere(subject);
  }

  private assertPositiveAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Credit amount must be a positive integer.',
      );
    }
  }

  /**
   * The metadata to store, carrying an adjust's signed delta.
   *
   * Only `adjust` needs it. `grant` and `refund` are always credits and `spend` is
   * always a debit, so for those the direction is implied by `type` and already
   * compared on replay. `adjust` is the one mutation whose sign is independent of
   * its type — `amount` is `Math.abs(delta)` — which made `+100` and `-100`
   * indistinguishable to `assertReplayMatches`.
   *
   * Stored in `metadata` rather than a new column because the field already exists
   * for operation detail and needs no migration, and rather than deriving the sign
   * from `balanceAfter` because that needs the *previous* balance, which is only
   * recoverable by walking the ledger and is not stable against interleaved
   * entries from concurrent mutations.
   */
  private metadataWithDelta(params: {
    type: string;
    delta: number;
    metadata?: Prisma.InputJsonValue;
  }): Prisma.InputJsonValue | undefined {
    if (params.type !== 'adjust') {
      return params.metadata;
    }

    const base =
      typeof params.metadata === 'object' &&
      params.metadata !== null &&
      !Array.isArray(params.metadata)
        ? params.metadata
        : {};

    return { ...base, [ADJUST_DELTA_KEY]: params.delta };
  }

  /** The signed delta recorded on an adjust entry, when it has one. */
  private storedDelta(entry: CreditLedgerEntry): number | undefined {
    const metadata = entry.metadata;

    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      return undefined;
    }

    const value = (metadata as Record<string, unknown>)[ADJUST_DELTA_KEY];

    return typeof value === 'number' ? value : undefined;
  }

  private assertReplayMatches(
    existing: CreditLedgerEntry,
    params: {
      type: string;
      amount: number;
      delta: number;
      subject: BillingSubject;
      feature?: string;
    },
  ): void {
    const ownerMismatch =
      params.subject.type === 'organization'
        ? existing.organizationId !== params.subject.organizationId
        : existing.userId !== params.subject.userId;

    /**
     * Direction, for adjusts that recorded it.
     *
     * Entries written before this change carry no stored delta, so their direction
     * cannot be verified — those fall back to the comparison below rather than
     * being rejected. Refusing every pre-existing adjust key would turn a
     * hardening change into an outage. A real, bounded gap: keys already used
     * before this shipped stay unverifiable for direction.
     */
    const recordedDelta =
      params.type === 'adjust' ? this.storedDelta(existing) : undefined;
    const directionMismatch =
      recordedDelta !== undefined && recordedDelta !== params.delta;

    if (
      ownerMismatch ||
      directionMismatch ||
      existing.type !== params.type ||
      existing.amount !== params.amount ||
      (params.feature !== undefined && existing.feature !== params.feature)
    ) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'Idempotency key was reused with a conflicting credit mutation.',
        { idempotencyKey: existing.idempotencyKey },
      );
    }
  }
}
