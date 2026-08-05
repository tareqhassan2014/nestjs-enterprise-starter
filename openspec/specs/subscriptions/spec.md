# Subscriptions

## Purpose

User↔plan subscription records with monthly/yearly billing intervals, lifecycle states (`active`, `past_due`, `canceled`), effective-plan resolution with Lite fallback, and an authenticated current-plan read surface.

## Requirements

### Requirement: User subscriptions bind a plan and billing interval

The system SHALL persist subscriptions that associate a user with a plan and a billing interval of `monthly` or `yearly`.

A subscription MUST record lifecycle status and period bounds sufficient to decide whether the subscription is currently entitled. Optional external billing identifiers MAY be stored as nullable fields for a later Stripe integration but MUST NOT be required for local entitlement decisions.

#### Scenario: Monthly Pro subscription

- **WHEN** a user is assigned an `active` subscription to Pro with interval `monthly`
- **THEN** resolution reports Pro as that user's effective plan and `monthly` as the interval

#### Scenario: Yearly interval stored

- **WHEN** a subscription is created with interval `yearly`
- **THEN** the persisted interval is `yearly` and is returned by the current-plan read surface

### Requirement: Subscription lifecycle states

A subscription's status SHALL be one of `active`, `past_due`, or `canceled`.

Entitlement eligibility MUST follow:

- `active` — entitled
- `past_due` — entitled (payment-grace)
- `canceled` — entitled only while `currentPeriodEnd` is present and strictly in the future; otherwise not entitled

#### Scenario: Active subscription is entitled

- **WHEN** the user's subscription status is `active`
- **THEN** plan gates and plan usage matrices for that subscription's plan apply

#### Scenario: Past due remains entitled

- **WHEN** the user's subscription status is `past_due`
- **THEN** the user remains entitled to that plan's entitlements and matrices

#### Scenario: Canceled within paid period remains entitled

- **WHEN** the user's subscription status is `canceled` and `currentPeriodEnd` is in the future
- **THEN** the user remains entitled until that timestamp

#### Scenario: Canceled after period end is not entitled

- **WHEN** the user's subscription status is `canceled` and `currentPeriodEnd` is absent or in the past
- **THEN** that subscription does not confer entitlements or plan matrices

### Requirement: Effective plan resolution with Lite fallback

The system SHALL resolve a caller's effective plan for gates and usage matrices by selecting an entitled subscription when one exists, otherwise treating the seeded `lite` plan as the effective plan.

Resolution MUST be available to the entitlements guard and to usage-ceiling lookup, and MUST key off the authenticated user id without a second session lookup.

#### Scenario: Entitled subscription wins

- **WHEN** a user has an entitled Pro subscription
- **THEN** effective plan is Pro

#### Scenario: No subscription falls back to Lite

- **WHEN** an authenticated user has no entitled subscription
- **THEN** effective plan is the seeded `lite` plan

#### Scenario: Expired canceled falls back to Lite

- **WHEN** a user's only subscription is `canceled` with `currentPeriodEnd` in the past
- **THEN** effective plan is Lite

### Requirement: Authenticated current-plan read surface

The system SHALL expose an authenticated, enveloped read endpoint under the versioned API that returns the caller's effective plan slug, subscription status and interval when a subscription row exists, enabled entitlements, and applicable usage ceilings for catalogue features.

The endpoint MUST NOT require a staff permission beyond authentication. It MUST NOT expose other users' subscriptions.

#### Scenario: Caller reads own effective plan

- **WHEN** an authenticated user requests the current-plan endpoint
- **THEN** the response is `200` with the success envelope and data describing that user's effective plan and entitlements

#### Scenario: Unauthenticated denied

- **WHEN** the current-plan endpoint is called without a session
- **THEN** the response is `401` with error code `UNAUTHORIZED`

### Requirement: Cross-user subscription inspection is an admin concern

Inspection of another user's subscription and effective plan SHALL be provided only through the admin monitoring HTTP surface and MUST require `admin:subscriptions:read`.

The authenticated current-plan read surface MUST remain limited to the caller's own effective plan and MUST NOT require staff permissions beyond authentication.

#### Scenario: Self-service current plan stays own-user

- **WHEN** an authenticated non-admin user requests the current-plan endpoint
- **THEN** the response describes that user's effective plan and does not expose another user's subscription

#### Scenario: Admin inspection uses the same resolution rules

- **WHEN** an admin reads another user's subscription view
- **THEN** the effective plan matches what plan gates and usage matrices would resolve for that user id
