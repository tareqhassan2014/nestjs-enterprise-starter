import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { usageLimitsConfig } from '@config/usage-limits.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import { assertUsageFeature, type UsageFeature } from './usage-features';

export type UsagePeriod = 'day' | 'week';

export interface UsageSubject {
  userId: string;
  orgId?: string;
}

export interface UsageSnapshot {
  feature: UsageFeature;
  period: UsagePeriod;
  used: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * UTC calendar-day and ISO-week usage counters on Redis.
 *
 * Keys:
 *   usage:{day|week}:{feature}:u:{userId}
 *   usage:{day|week}:{feature}:o:{orgId}   (optional; both enforced when set)
 */
@Injectable()
export class UsageLimitsService {
  private readonly logger = new Logger(UsageLimitsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(usageLimitsConfig.KEY)
    private readonly config: ConfigType<typeof usageLimitsConfig>,
  ) {}

  async check(
    subject: UsageSubject,
    feature: UsageFeature,
    period: UsagePeriod,
  ): Promise<UsageSnapshot> {
    assertUsageFeature(feature);
    const limit = this.ceiling(feature, period);
    const keys = this.keysFor(subject, feature, period);

    try {
      const values = await this.redis.mget(...keys);
      const used = Math.max(
        ...values.map((value) => (value ? Number(value) : 0)),
        0,
      );

      return {
        feature,
        period,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        retryAfterSeconds: this.secondsUntilPeriodEnd(period),
      };
    } catch (error) {
      this.failClosed(error);
    }
  }

  /**
   * Atomically check-and-increment daily and weekly counters. Throws
   * `USAGE_LIMIT_EXCEEDED` when either ceiling is already exhausted.
   */
  async consume(
    subject: UsageSubject,
    feature: UsageFeature,
    periods: UsagePeriod[] = ['day', 'week'],
  ): Promise<void> {
    assertUsageFeature(feature);

    for (const period of periods) {
      const snapshot = await this.check(subject, feature, period);

      if (snapshot.remaining <= 0) {
        this.throwExceeded(snapshot);
      }
    }

    try {
      for (const period of periods) {
        const ttl = this.secondsUntilPeriodEnd(period);
        const keys = this.keysFor(subject, feature, period);

        for (const key of keys) {
          const next = await this.redis.incr(key);
          if (next === 1) {
            await this.redis.expire(key, ttl);
          }

          const limit = this.ceiling(feature, period);
          if (next > limit) {
            // Race: another request won the last slot. Roll back and reject.
            await this.redis.decr(key);
            this.throwExceeded({
              feature,
              period,
              used: limit,
              limit,
              remaining: 0,
              retryAfterSeconds: ttl,
            });
          }
        }
      }
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }

      this.failClosed(error);
    }
  }

  ceiling(feature: UsageFeature, period: UsagePeriod): number {
    const override = this.config.features[feature];
    const source = override ?? this.config.default;
    return period === 'day' ? source.daily : source.weekly;
  }

  keysFor(
    subject: UsageSubject,
    feature: UsageFeature,
    period: UsagePeriod,
    at: Date = new Date(),
  ): string[] {
    const stamp = this.periodStamp(period, at);
    const keys = [`usage:${period}:${stamp}:${feature}:u:${subject.userId}`];

    if (subject.orgId) {
      keys.push(`usage:${period}:${stamp}:${feature}:o:${subject.orgId}`);
    }

    return keys;
  }

  periodStamp(period: UsagePeriod, at: Date = new Date()): string {
    if (period === 'day') {
      return at.toISOString().slice(0, 10);
    }

    return isoWeekStamp(at);
  }

  secondsUntilPeriodEnd(period: UsagePeriod, at: Date = new Date()): number {
    if (period === 'day') {
      const next = Date.UTC(
        at.getUTCFullYear(),
        at.getUTCMonth(),
        at.getUTCDate() + 1,
      );
      return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
    }

    const day = at.getUTCDay() || 7; // Monday=1 … Sunday=7
    const end = Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate() + (8 - day),
    );
    return Math.max(1, Math.ceil((end - at.getTime()) / 1000));
  }

  private throwExceeded(snapshot: UsageSnapshot): never {
    throw new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      ErrorCode.USAGE_LIMIT_EXCEEDED,
      'Usage limit exceeded for this period.',
      {
        feature: snapshot.feature,
        period: snapshot.period,
        limit: snapshot.limit,
        remaining: 0,
      },
      { 'Retry-After': String(snapshot.retryAfterSeconds) },
    );
  }

  private failClosed(error: unknown): never {
    this.logger.warn(
      `Usage storage failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      ErrorCode.SERVICE_UNAVAILABLE,
      'Usage limits temporarily unavailable.',
    );
  }
}

/** ISO week stamp `YYYY-Www` in UTC. */
function isoWeekStamp(at: Date): string {
  const date = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
  // Thursday in current week decides the year.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
