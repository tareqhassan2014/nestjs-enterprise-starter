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

export const CREDITS_LOW_BALANCE_EVENT = 'credits.low_balance';

export interface CreditsLowBalancePayload {
  userId: string;
  balance: number;
  threshold: number;
}

export interface CreditMutationResult {
  entry: CreditLedgerEntry;
  balance: number;
  replayed: boolean;
}

type Tx = Prisma.TransactionClient;

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

  async getBalance(userId: string): Promise<number> {
    const wallet = await this.prisma.creditWallet.findUnique({
      where: { userId },
    });
    return wallet?.balance ?? 0;
  }

  async listLedger(
    userId: string,
    limit = 20,
  ): Promise<CreditLedgerEntry[]> {
    const take = Math.min(Math.max(limit, 1), 100);
    return this.prisma.creditLedgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async grant(params: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<CreditMutationResult> {
    this.assertPositiveAmount(params.amount);
    return this.apply({
      userId: params.userId,
      type: 'grant',
      amount: params.amount,
      delta: params.amount,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
    });
  }

  async spend(params: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    feature?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<CreditMutationResult> {
    this.assertPositiveAmount(params.amount);
    return this.apply({
      userId: params.userId,
      type: 'spend',
      amount: params.amount,
      delta: -params.amount,
      idempotencyKey: params.idempotencyKey,
      feature: params.feature,
      metadata: params.metadata,
      failIfInsufficient: true,
    });
  }

  async refund(params: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    feature?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<CreditMutationResult> {
    this.assertPositiveAmount(params.amount);
    return this.apply({
      userId: params.userId,
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
  async adjust(params: {
    userId: string;
    delta: number;
    idempotencyKey: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<CreditMutationResult> {
    if (!Number.isInteger(params.delta) || params.delta === 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Adjust delta must be a non-zero integer.',
      );
    }

    return this.apply({
      userId: params.userId,
      type: 'adjust',
      amount: Math.abs(params.delta),
      delta: params.delta,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
      failIfInsufficient: params.delta < 0,
    });
  }

  private async apply(params: {
    userId: string;
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
      await this.ensureWallet(tx, params.userId);
      await this.lockWallet(tx, params.userId);
      const wallet = await tx.creditWallet.findUniqueOrThrow({
        where: { userId: params.userId },
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
        where: { userId: params.userId },
        data: { balance: nextBalance },
      });

      const entry = await tx.creditLedgerEntry.create({
        data: {
          userId: params.userId,
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
      this.emitLowBalance(params.userId, result.balance);
    }

    return result;
  }

  private shouldEmitLowBalance(balance: number): boolean {
    const threshold = this.credits.lowBalanceThreshold;
    return threshold !== undefined && balance <= threshold;
  }

  private emitLowBalance(userId: string, balance: number): void {
    const threshold = this.credits.lowBalanceThreshold!;
    const payload: CreditsLowBalancePayload = {
      userId,
      balance,
      threshold,
    };

    this.logger.warn({
      msg: 'Credit balance at or below threshold',
      ...payload,
    });

    this.events.emit(CREDITS_LOW_BALANCE_EVENT, payload);
  }

  private async lockWallet(tx: Tx, userId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT 1 FROM credit_wallets WHERE "userId" = ${userId} FOR UPDATE
    `;
  }

  private async ensureWallet(
    tx: Tx,
    userId: string,
  ): Promise<{ userId: string; balance: number }> {
    return tx.creditWallet.upsert({
      where: { userId },
      create: { userId, balance: 0 },
      update: {},
    });
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
      userId: string;
      feature?: string;
    },
  ): void {
    if (
      existing.userId !== params.userId ||
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
