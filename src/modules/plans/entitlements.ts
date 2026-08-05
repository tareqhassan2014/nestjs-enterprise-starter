/**
 * Commercial entitlement vocabulary. Code owns this list; the database owns
 * which plans enable each flag.
 *
 * Typed into `@RequireEntitlement` so a misspelled key fails the build. The
 * seed upserts a `(plan, key)` row for every declared entitlement on every
 * seeded plan. A DB row whose key is absent here is inert.
 */
export const ENTITLEMENTS = {
  FEATURE_ADVANCED: 'feature.advanced',
  FEATURE_PRIORITY_SUPPORT: 'feature.priority_support',
} as const;

export type Entitlement = (typeof ENTITLEMENTS)[keyof typeof ENTITLEMENTS];

export const ENTITLEMENT_LIST = Object.values(ENTITLEMENTS);

export const ENTITLEMENT_DESCRIPTIONS: Record<Entitlement, string> = {
  [ENTITLEMENTS.FEATURE_ADVANCED]:
    'Access to advanced product features gated behind Pro and above',
  [ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT]:
    'Priority support channel (Enterprise)',
};

export function isEntitlement(value: string): value is Entitlement {
  return (ENTITLEMENT_LIST as readonly string[]).includes(value);
}

/** Stable plan slugs. Rank ordering is enforced in seed data, not here. */
export const PLAN_SLUGS = {
  LITE: 'lite',
  PRO: 'pro',
  ENTERPRISE: 'enterprise',
} as const;

export type PlanSlug = (typeof PLAN_SLUGS)[keyof typeof PLAN_SLUGS];

export const PLAN_SLUG_LIST = Object.values(PLAN_SLUGS);

export function isPlanSlug(value: string): value is PlanSlug {
  return (PLAN_SLUG_LIST as readonly string[]).includes(value);
}
