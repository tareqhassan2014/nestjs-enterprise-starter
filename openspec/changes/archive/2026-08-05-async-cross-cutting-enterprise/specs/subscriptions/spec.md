## ADDED Requirements

### Requirement: Organization subscriptions for org-primary billing

The system SHALL allow a subscription row to bind either a user or an organization (exactly one) to a plan and billing interval. When the billing subject is an organization, entitlement and plan-matrix resolution MUST use the organization's entitled subscription when present.

#### Scenario: Org Pro subscription

- **WHEN** an organization has an `active` subscription to Pro with interval `monthly` and a member operates in org-primary context
- **THEN** effective plan resolution reports Pro for that billing subject

#### Scenario: User subscription unaffected

- **WHEN** only a user subscription exists and context is user-primary
- **THEN** resolution continues to use that user's subscription as today

## MODIFIED Requirements

### Requirement: User subscriptions bind a plan and billing interval

The system SHALL persist subscriptions that associate exactly one billing owner — a user or an organization — with a plan and a billing interval of `monthly` or `yearly`.

A subscription MUST record lifecycle status and period bounds sufficient to decide whether the subscription is currently entitled. Optional external billing identifiers MAY be stored as nullable fields for a later Stripe integration but MUST NOT be required for local entitlement decisions.

#### Scenario: Monthly Pro subscription

- **WHEN** a user is assigned an `active` subscription to Pro with interval `monthly`
- **THEN** resolution reports Pro as that user's effective plan and `monthly` as the interval

#### Scenario: Yearly interval stored

- **WHEN** a subscription is created with interval `yearly`
- **THEN** the persisted interval is `yearly` and is returned by the current-plan read surface

#### Scenario: Organization-owned subscription stored

- **WHEN** a subscription is created with an organization owner and interval `monthly`
- **THEN** the persisted row references that organization and not a user owner

### Requirement: Effective plan resolution with Lite fallback

The system SHALL resolve a caller's effective plan for gates and usage matrices by selecting an entitled subscription for the active billing subject when one exists, otherwise treating the seeded `lite` plan as the effective plan.

Resolution MUST be available to the entitlements guard and to usage-ceiling lookup. It MUST key off the billing subject (authenticated user id and optional organization id from context) without a second session lookup.

#### Scenario: Entitled subscription wins

- **WHEN** a user has an entitled Pro subscription in user-primary context
- **THEN** effective plan is Pro

#### Scenario: No subscription falls back to Lite

- **WHEN** an authenticated user has no entitled subscription in user-primary context
- **THEN** effective plan is the seeded `lite` plan

#### Scenario: Expired canceled falls back to Lite

- **WHEN** a user's only subscription is `canceled` with `currentPeriodEnd` in the past
- **THEN** effective plan is Lite

#### Scenario: Org-primary uses org subscription

- **WHEN** org-primary context is active and the organization has an entitled Pro subscription while the user personally has only Lite
- **THEN** effective plan for gates is Pro
