import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  type BillingInterval,
  type SubscriptionStatus,
} from '@/generated/prisma/client';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import {
  type BillingSubject,
  userSubject,
} from '@modules/organizations/billing-subject';
import {
  assertUsageFeature,
  type UsageFeature,
} from '@modules/usage-limits/usage-features';

import {
  ENTITLEMENT_LIST,
  type Entitlement,
  PLAN_SLUGS,
  type PlanSlug,
} from './entitlements';

export interface PlanUsageCeilings {
  daily: number;
  weekly: number;
}

export interface EffectivePlan {
  planId: string;
  slug: PlanSlug | string;
  name: string;
  rank: number;
  /** True when an entitled subscription row is in force (not Lite fallback). */
  fromSubscription: boolean;
  subscriptionId: string | null;
  status: SubscriptionStatus | null;
  interval: BillingInterval | null;
  currentPeriodEnd: Date | null;
  entitlements: Readonly<Record<string, boolean>>;
  usageLimits: Readonly<Record<string, PlanUsageCeilings>>;
}

interface CachedPlanMatrix {
  id: string;
  slug: string;
  name: string;
  rank: number;
  entitlements: Record<string, boolean>;
  usageLimits: Record<string, PlanUsageCeilings>;
}

/**
 * Resolves the caller's effective commercial plan: an entitled subscription's
 * plan when one exists, otherwise the seeded Lite plan.
 *
 * Plan matrices are cached in-process at boot (seed/redeploy refreshes them).
 * Per-user subscription identity is read from Postgres on each resolve call;
 * callers may memoize on the request object.
 */
@Injectable()
export class PlanResolutionService implements OnModuleInit {
  private readonly logger = new Logger(PlanResolutionService.name);
  private matricesById = new Map<string, CachedPlanMatrix>();
  private matricesBySlug = new Map<string, CachedPlanMatrix>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reloadMatrices();
  }

  /** Reload plan entitlement/usage matrices from the database. */
  async reloadMatrices(): Promise<void> {
    const plans = await this.prisma.plan.findMany({
      include: {
        entitlements: true,
        usageLimits: true,
      },
    });

    const byId = new Map<string, CachedPlanMatrix>();
    const bySlug = new Map<string, CachedPlanMatrix>();

    for (const plan of plans) {
      const entitlements: Record<string, boolean> = {};
      for (const key of ENTITLEMENT_LIST) {
        entitlements[key] = false;
      }
      for (const row of plan.entitlements) {
        entitlements[row.entitlementKey] = row.enabled;
      }

      const usageLimits: Record<string, PlanUsageCeilings> = {};
      for (const row of plan.usageLimits) {
        usageLimits[row.feature] = {
          daily: row.dailyLimit,
          weekly: row.weeklyLimit,
        };
      }

      const cached: CachedPlanMatrix = {
        id: plan.id,
        slug: plan.slug,
        name: plan.name,
        rank: plan.rank,
        entitlements,
        usageLimits,
      };
      byId.set(plan.id, cached);
      bySlug.set(plan.slug, cached);
    }

    this.matricesById = byId;
    this.matricesBySlug = bySlug;

    if (!bySlug.has(PLAN_SLUGS.LITE)) {
      this.logger.warn(
        `Plan catalogue missing slug "${PLAN_SLUGS.LITE}". Run pnpm db:seed.`,
      );
    }
  }

  /**
   * Resolves the effective plan for a `BillingSubject`, or — for every
   * caller written before organizations existed — a bare `userId` string.
   * An organization subject resolves against its own subscriptions rather
   * than any member's; see `BillingSubjectResolver` and design.md decision 4.
   */
  async resolve(
    subject: BillingSubject | string,
    now: Date = new Date(),
  ): Promise<EffectivePlan> {
    const resolved =
      typeof subject === 'string' ? userSubject(subject) : subject;
    const subscriptions = await this.prisma.subscription.findMany({
      where:
        resolved.type === 'organization'
          ? { organizationId: resolved.organizationId }
          : { userId: resolved.userId },
      orderBy: { updatedAt: 'desc' },
    });

    const entitled = subscriptions.find((subscription) =>
      this.isEntitled(subscription.status, subscription.currentPeriodEnd, now),
    );

    if (entitled) {
      const matrix = this.matricesById.get(entitled.planId);
      if (matrix) {
        return this.toEffective(matrix, {
          fromSubscription: true,
          subscriptionId: entitled.id,
          status: entitled.status,
          interval: entitled.interval,
          currentPeriodEnd: entitled.currentPeriodEnd,
        });
      }

      this.logger.warn(
        `Subscription ${entitled.id} references unknown plan ${entitled.planId}; falling back to Lite.`,
      );
    }

    return this.liteFallback();
  }

  hasEntitlement(plan: EffectivePlan, key: Entitlement): boolean {
    return plan.entitlements[key] === true;
  }

  meetsMinimumPlan(plan: EffectivePlan, minimumSlug: PlanSlug): boolean {
    const minimum = this.matricesBySlug.get(minimumSlug);
    if (!minimum) {
      return false;
    }

    return plan.rank >= minimum.rank;
  }

  usageCeiling(
    plan: EffectivePlan,
    feature: UsageFeature,
    period: 'day' | 'week',
  ): number | undefined {
    assertUsageFeature(feature);
    const row = plan.usageLimits[feature];
    if (!row) {
      return undefined;
    }

    return period === 'day' ? row.daily : row.weekly;
  }

  isEntitled(
    status: SubscriptionStatus,
    currentPeriodEnd: Date | null,
    now: Date = new Date(),
  ): boolean {
    if (status === 'active' || status === 'past_due') {
      return true;
    }

    if (status === 'canceled') {
      return (
        currentPeriodEnd !== null && currentPeriodEnd.getTime() > now.getTime()
      );
    }

    return false;
  }

  private liteFallback(): EffectivePlan {
    const lite = this.matricesBySlug.get(PLAN_SLUGS.LITE);
    if (!lite) {
      // Seed missing — return a conservative empty Lite so gates fail closed
      // on premium entitlements rather than crashing the request.
      return {
        planId: '',
        slug: PLAN_SLUGS.LITE,
        name: 'Lite',
        rank: 10,
        fromSubscription: false,
        subscriptionId: null,
        status: null,
        interval: null,
        currentPeriodEnd: null,
        entitlements: Object.fromEntries(
          ENTITLEMENT_LIST.map((key) => [key, false]),
        ),
        usageLimits: {},
      };
    }

    return this.toEffective(lite, {
      fromSubscription: false,
      subscriptionId: null,
      status: null,
      interval: null,
      currentPeriodEnd: null,
    });
  }

  private toEffective(
    matrix: CachedPlanMatrix,
    subscription: {
      fromSubscription: boolean;
      subscriptionId: string | null;
      status: SubscriptionStatus | null;
      interval: BillingInterval | null;
      currentPeriodEnd: Date | null;
    },
  ): EffectivePlan {
    return {
      planId: matrix.id,
      slug: matrix.slug,
      name: matrix.name,
      rank: matrix.rank,
      fromSubscription: subscription.fromSubscription,
      subscriptionId: subscription.subscriptionId,
      status: subscription.status,
      interval: subscription.interval,
      currentPeriodEnd: subscription.currentPeriodEnd,
      entitlements: matrix.entitlements,
      usageLimits: matrix.usageLimits,
    };
  }
}
