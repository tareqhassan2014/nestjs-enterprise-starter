import { USAGE_FEATURES } from '../usage-limits/usage-features';

import {
  ENTITLEMENT_LIST,
  ENTITLEMENTS,
  type Entitlement,
  PLAN_SLUGS,
  type PlanSlug,
} from './entitlements';

export interface PlanSeedDefinition {
  slug: PlanSlug;
  name: string;
  description: string;
  rank: number;
  isActive: boolean;
  entitlements: Record<Entitlement, boolean>;
  /**
   * Daily/weekly ceilings per usage-feature catalogue entry. Very large values
   * act as a practical "unlimited" sentinel (null is avoided so remaining maths
   * stay simple).
   */
  usageLimits: Record<
    string,
    { dailyLimit: number; weeklyLimit: number }
  >;
}

/**
 * Starter commercial packaging. Seed upserts from this; forks edit here (and
 * re-seed) rather than inventing a parallel env map per plan.
 */
export const PLAN_SEEDS: readonly PlanSeedDefinition[] = [
  {
    slug: PLAN_SLUGS.LITE,
    name: 'Lite',
    description: 'Default starter tier for new accounts',
    rank: 10,
    isActive: true,
    entitlements: {
      [ENTITLEMENTS.FEATURE_ADVANCED]: false,
      [ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT]: false,
    },
    usageLimits: {
      [USAGE_FEATURES.DEMO]: { dailyLimit: 100, weeklyLimit: 500 },
    },
  },
  {
    slug: PLAN_SLUGS.PRO,
    name: 'Pro',
    description: 'Paid tier with advanced features and higher ceilings',
    rank: 20,
    isActive: true,
    entitlements: {
      [ENTITLEMENTS.FEATURE_ADVANCED]: true,
      [ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT]: false,
    },
    usageLimits: {
      [USAGE_FEATURES.DEMO]: { dailyLimit: 1_000, weeklyLimit: 5_000 },
    },
  },
  {
    slug: PLAN_SLUGS.ENTERPRISE,
    name: 'Enterprise',
    description: 'Optional highest tier; forks may deactivate to hide it',
    rank: 30,
    isActive: true,
    entitlements: {
      [ENTITLEMENTS.FEATURE_ADVANCED]: true,
      [ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT]: true,
    },
    usageLimits: {
      [USAGE_FEATURES.DEMO]: { dailyLimit: 100_000, weeklyLimit: 500_000 },
    },
  },
];

/** Every entitlement key the seed must cover (guards against partial records). */
export { ENTITLEMENT_LIST };
