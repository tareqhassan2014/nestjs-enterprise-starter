/**
 * Code-declared usage feature catalogue. Callers cannot invent unbounded
 * feature strings at runtime — unknown ids fail as a programming error.
 */
export const USAGE_FEATURES = {
  DEMO: 'demo',
} as const;

export type UsageFeature = (typeof USAGE_FEATURES)[keyof typeof USAGE_FEATURES];

const FEATURE_SET = new Set<string>(Object.values(USAGE_FEATURES));

export function assertUsageFeature(
  feature: string,
): asserts feature is UsageFeature {
  if (!FEATURE_SET.has(feature)) {
    throw new Error(
      `Unknown usage feature "${feature}". Add it to USAGE_FEATURES before metering.`,
    );
  }
}

export function isUsageFeature(feature: string): feature is UsageFeature {
  return FEATURE_SET.has(feature);
}
