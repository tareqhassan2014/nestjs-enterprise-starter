/**
 * The complete flag vocabulary. `FeatureFlagsService.isEnabled` only accepts
 * keys from this object — forks add flags here (and a code default below)
 * rather than inventing free-form strings at call sites. Mirrors how
 * `CREDIT_COSTS` and `USAGE_FEATURES` keep their vocabularies in code.
 */
export const FEATURE_FLAGS = {
  /** Bridges `credits.low_balance` to the `email` queue when enabled. */
  EMAIL_LOW_BALANCE: 'email.low_balance',
  /** Master switch for org-primary billing subject resolution. */
  ORG_BILLING: 'org.billing',
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

export const FEATURE_FLAG_LIST: readonly FeatureFlagKey[] =
  Object.values(FEATURE_FLAGS);

/**
 * Last-resort default when neither a DB override nor an env default (see
 * `featureFlagsConfig`) applies. Env defaults exist for every flag today, so
 * this is mostly a safety net for a flag added without one.
 */
export const FEATURE_FLAG_CODE_DEFAULTS: Readonly<
  Record<FeatureFlagKey, boolean>
> = {
  [FEATURE_FLAGS.EMAIL_LOW_BALANCE]: false,
  [FEATURE_FLAGS.ORG_BILLING]: true,
};

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return (FEATURE_FLAG_LIST as readonly string[]).includes(value);
}
