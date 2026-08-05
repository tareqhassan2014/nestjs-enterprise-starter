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
          metadata: params.metadata,
        },
      });

      return { entry, balance: updated.balance, replayed: false };
    });

    if (!result.replayed) {
      this.metrics?.recordCreditMutation(params.type);
    }

    if (
      !result.replayed &&
      params.type === 'spend' &&
      this.shouldEmitLowBalance(result.balance)
    ) {
      this.emitLowBalance(params.subject, result.balance);
    }

    return result;
  }

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

  private assertReplayMatches(
    existing: CreditLedgerEntry,
    params: {
      type: string;
      amount: number;
      subject: BillingSubject;
      feature?: string;
    },
  ): void {
    const ownerMismatch =
      params.subject.type === 'organization'
        ? existing.organizationId !== params.subject.organizationId
        : existing.userId !== params.subject.userId;

    if (
      ownerMismatch ||
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
