import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { usageLimitsConfig } from '@config/usage-limits.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import {
  type BillingSubject,
  userSubject,
} from '@modules/organizations/billing-subject';
import {
  type EffectivePlan,
  PlanResolutionService,
} from '@modules/plans/plan-resolution.service';

import {
  assertUsageFeature,
  type UsageFeature,
  USAGE_FEATURE_LIST,
} from './usage-features';

export type UsagePeriod = 'day' | 'week';

/** The organization half of a usage subject, as the billing resolver produces it. */
export type UsageOrganization = Extract<
  BillingSubject,
  { type: 'organization' }
>;

/**
 * Who a consume is metered against.
 *
 * Two dimensions, deliberately — usage answers *who acted* as well as *whose
 * quota was spent*, where a credit debit answers only the second. That is why
 * this is not simply a `BillingSubject`: the union's organization variant carries
 * no `userId`, so adopting it wholesale would drop the acting member's own
 * ceiling and let one member exhaust an organization's entire allowance.
 *
 * The organization half *is* `BillingSubject`'s own variant rather than a bare
 * id, so `BillingSubjectResolver` remains the single place that decides what an
 * organization subject is and whether org-primary billing applies at all.
 */
export interface UsageSubject {
  /** The acting member. Their own ceiling always applies. */
  actorUserId: string;
  /** Set when the request is bound to an organization that bills itself. */
  billing?: UsageOrganization;
}

/** Convenience for the common member-only case. */
export function usageSubject(actorUserId: string): UsageSubject {
  return { actorUserId };
}

/** One counter, paired with the billing subject whose plan sets its ceiling. */
interface UsageScope {
  key: string;
  owner: BillingSubject;
}

/**
 * Effective plans already resolved during one `consume`, keyed by subject scope.
 *
 * Call-scoped only — see `ceilingForOwner` for why this must not become a
 * cross-request cache.
 */
type PlanMemo = Map<string, EffectivePlan>;

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
 *
 * Ceilings prefer the caller's effective plan matrix when present, otherwise
 * validated env/config defaults.
 */
@Injectable()
export class UsageLimitsService {
  private readonly logger = new Logger(UsageLimitsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(usageLimitsConfig.KEY)
    private readonly config: ConfigType<typeof usageLimitsConfig>,
    @Optional() private readonly plans?: PlanResolutionService,
  ) {}

  /**
   * The tightest snapshot across every scope the subject is metered against.
   *
   * "Tightest" rather than "highest count": each scope is compared against **its
   * own** ceiling, then the one with the least headroom is reported. The previous
   * implementation took `Math.max` of the counts and compared that single number
   * to the caller's ceiling, which meant an organization's aggregate count was
   * measured against one member's allowance — so an org limit could never exceed a
   * member's, however the plan matrices were configured.
   */
  async check(
    subject: UsageSubject,
    feature: UsageFeature,
    period: UsagePeriod,
    plans: PlanMemo = new Map(),
  ): Promise<UsageSnapshot> {
    assertUsageFeature(feature);

    try {
      const scopes = this.scopesFor(subject, feature, period);
      const values = await this.redis.mget(...scopes.map((scope) => scope.key));

      const snapshots = await Promise.all(
        scopes.map(async (scope, index) => {
          const used = values[index] ? Number(values[index]) : 0;
          const limit = await this.ceilingForOwner(
            scope.owner,
            feature,
            period,
            plans,
          );

          return {
            feature,
            period,
            used,
            limit,
            remaining: Math.max(0, limit - used),
            retryAfterSeconds: this.secondsUntilPeriodEnd(period),
          };
        }),
      );

      return snapshots.reduce((tightest, snapshot) =>
        snapshot.remaining < tightest.remaining ? snapshot : tightest,
      );
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }

      /**
       * Ceiling resolution sits inside this boundary deliberately. It reads
       * persisted subscriptions, and a database failure there used to escape as
       * `500 INTERNAL_ERROR` while an identical-looking counter-store failure gave
       * `503`. The caller's remedy is the same for both, so the status is too.
       */
      this.failClosed(error);
    }
  }

  /**
   * Check-and-increment every counter for the given periods, or leave them all as
   * they were. Throws `USAGE_LIMIT_EXCEEDED` when any ceiling is exhausted.
   *
   * **Not atomic** — the previous doc comment claimed it was, and it never has
   * been. This is compensation: increments are applied, and if a later one is
   * refused every increment already applied in this call is rolled back. The
   * residual is a crash between an increment and its rollback, which leaves a
   * counter high for the remainder of the period. Accepted because the keys are
   * TTL-bounded and the window is milliseconds; the risk is a slightly inflated
   * counter, never a bypassed ceiling.
   *
   * True atomicity would need the ceilings inside the atomic section, and they
   * come from a Postgres read — see design.md decision 4 for why that is a larger
   * change than it looks.
   *
   * `plans` memoizes plan resolution across every period and scope in this call:
   * the same effective plan was previously resolved once per period in the
   * pre-check and again per counter in the increment loop, four uncached
   * `subscription.findMany` queries for one metered request.
   */
  async consume(
    subject: UsageSubject,
    feature: UsageFeature,
    periods: UsagePeriod[] = ['day', 'week'],
  ): Promise<void> {
    assertUsageFeature(feature);

    const plans: PlanMemo = new Map();

    // Pre-check first, so the common exhausted case rejects without touching a
    // single counter and needs no rollback at all.
    for (const period of periods) {
      const snapshot = await this.check(subject, feature, period, plans);

      if (snapshot.remaining <= 0) {
        this.throwExceeded(snapshot);
      }
    }

    /** Every key incremented so far, for the rollback path. */
    const applied: string[] = [];

    try {
      for (const period of periods) {
        const ttl = this.secondsUntilPeriodEnd(period);

        for (const scope of this.scopesFor(subject, feature, period)) {
          const limit = await this.ceilingForOwner(
            scope.owner,
            feature,
            period,
            plans,
          );

          const next = await this.redis.incr(scope.key);
          applied.push(scope.key);

          if (next === 1) {
            await this.redis.expire(scope.key, ttl);
          }

          if (next > limit) {
            /**
             * Race: another request took the last slot between the pre-check and
             * here. Every key applied in this call is rolled back, not just this
             * one — decrementing only the offending counter left the caller
             * charged for a request that was denied, and repeated attempts against
             * one exhausted ceiling would drain the others.
             */
            await this.rollback(applied);

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

      // A storage failure mid-flight leaves the same obligation as a refusal.
      await this.rollback(applied);
      this.failClosed(error);
    }
  }

  /**
   * Undoes increments applied earlier in a `consume` that is about to fail.
   *
   * Best-effort by design: a failed rollback must not replace the caller's real
   * error (a quota refusal, or the storage failure that prompted it) with a
   * secondary one. The counters expire with their period, so the cost of a lost
   * rollback is bounded.
   */
  private async rollback(keys: string[]): Promise<void> {
    for (const key of keys.splice(0)) {
      try {
        await this.redis.decr(key);
      } catch (error: unknown) {
        this.logger.warn(
          `Could not roll back usage counter ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Config-only ceiling (no plan lookup). Kept for unit tests and callers that
   * already know they want env defaults.
   */
  ceiling(feature: UsageFeature, period: UsagePeriod): number {
    const override = this.config.features[feature];
    const source = override ?? this.config.default;
    return period === 'day' ? source.daily : source.weekly;
  }

  /**
   * Admin/ops snapshot of daily and weekly counters for a user across one or
   * all catalogue features. Read-only MGET of existing counters.
   */
  async snapshotsForUser(
    userId: string,
    feature?: UsageFeature,
  ): Promise<UsageSnapshot[]> {
    if (feature !== undefined) {
      assertUsageFeature(feature);
    }

    const catalogue = feature ? [feature] : USAGE_FEATURE_LIST;
    const subject = usageSubject(userId);
    const out: UsageSnapshot[] = [];

    /**
     * One memo across the whole sweep. This reads every catalogue feature over
     * two periods, and the caller's plan is the same for all of them — without
     * sharing it, an admin snapshot of N features would resolve the plan 2N times.
     */
    const plans: PlanMemo = new Map();

    for (const item of catalogue) {
      out.push(await this.check(subject, item, 'day', plans));
      out.push(await this.check(subject, item, 'week', plans));
    }

    return out;
  }

  /**
   * The ceiling for one billing subject, memoized per call.
   *
   * The memo is deliberately call-scoped and never shared across requests.
   * `PermissionResolver` caches its lookups across requests behind a version
   * marker because role mappings change rarely and invalidation is cheap to
   * trigger; subscriptions change through Stripe webhooks and admin adjustments,
   * and a stale plan ceiling is a billing-correctness problem. Taking the N+1 off
   * the hot path is worth doing; taking on an invalidation obligation nobody has
   * signed up for is not.
   */
  private async ceilingForOwner(
    owner: BillingSubject,
    feature: UsageFeature,
    period: UsagePeriod,
    plans: PlanMemo,
  ): Promise<number> {
    if (!this.plans) {
      return this.ceiling(feature, period);
    }

    const memoKey =
      owner.type === 'user' ? `u:${owner.userId}` : `o:${owner.organizationId}`;

    let effective = plans.get(memoKey);

    if (effective === undefined) {
      effective = await this.plans.resolve(owner);
      plans.set(memoKey, effective);
    }

    const fromPlan = this.plans.usageCeiling(effective, feature, period);

    return fromPlan ?? this.ceiling(feature, period);
  }

  /** Ceiling for a usage subject's acting member. Convenience for callers. */
  async ceilingFor(
    subject: UsageSubject,
    feature: UsageFeature,
    period: UsagePeriod,
  ): Promise<number> {
    return this.ceilingForOwner(
      userSubject(subject.actorUserId),
      feature,
      period,
      new Map(),
    );
  }

  /**
   * Every counter the subject is metered against, each paired with the billing
   * subject whose plan sets its ceiling.
   *
   * The acting member's counter is always present. An organization counter joins
   * it when the request is bound to one — and is governed by the *organization's*
   * plan, which is the whole point: measuring an org's aggregate against a
   * member's allowance makes an org-wide ceiling inexpressible.
   */
  scopesFor(
    subject: UsageSubject,
    feature: UsageFeature,
    period: UsagePeriod,
    at: Date = new Date(),
  ): UsageScope[] {
    const stamp = this.periodStamp(period, at);

    const scopes: UsageScope[] = [
      {
        key: `usage:${period}:${stamp}:${feature}:u:${subject.actorUserId}`,
        owner: userSubject(subject.actorUserId),
      },
    ];

    if (subject.billing) {
      scopes.push({
        key: `usage:${period}:${stamp}:${feature}:o:${subject.billing.organizationId}`,
        owner: subject.billing,
      });
    }

    return scopes;
  }

  /** The raw counter keys, for callers that only need the keyspace. */
  keysFor(
    subject: UsageSubject,
    feature: UsageFeature,
    period: UsagePeriod,
    at: Date = new Date(),
  ): string[] {
    return this.scopesFor(subject, feature, period, at).map(
      (scope) => scope.key,
    );
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
