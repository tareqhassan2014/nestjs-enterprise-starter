/**
 * The owner a credit wallet, subscription, or spend acts on behalf of.
 *
 * User-primary remains the default everywhere: callers that only ever pass a
 * `userId` (every route before this change) keep working unchanged. A
 * `BillingSubject` is how a request that is bound to an organization — and
 * whose org has opted into org-primary billing — tells `CreditService` /
 * `PlanResolutionService` to act on the org wallet/subscription instead. See
 * `BillingSubjectResolver` and design.md decision 4.
 */
export type BillingSubject =
  | { type: 'user'; userId: string }
  | { type: 'organization'; organizationId: string };

export function userSubject(userId: string): BillingSubject {
  return { type: 'user', userId };
}

export function organizationSubject(organizationId: string): BillingSubject {
  return { type: 'organization', organizationId };
}
