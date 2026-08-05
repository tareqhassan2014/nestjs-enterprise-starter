/**
 * Code-declared feature → credit cost catalogue.
 *
 * `@CostsCredits` only accepts keys from this object. Forks extend the map
 * (and seed/fixtures) rather than inventing free-form decorator strings.
 */
export const CREDIT_COSTS = {
  'demo.paid': 1,
} as const;

export type CreditFeature = keyof typeof CREDIT_COSTS;

export function creditCost(feature: CreditFeature): number {
  return CREDIT_COSTS[feature];
}
