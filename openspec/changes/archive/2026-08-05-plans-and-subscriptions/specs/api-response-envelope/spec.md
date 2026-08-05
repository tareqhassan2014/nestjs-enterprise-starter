## ADDED Requirements

### Requirement: Error codes for plan and subscription outcomes

The error code set SHALL include stable identifiers for commercial plan denials that clients must branch on, distinct from RBAC and from throttling/usage codes.

The set MUST include `ENTITLEMENT_DENIED` for missing plan entitlements or insufficient plan rank, and `SUBSCRIPTION_INACTIVE` for outcomes that specifically require an entitled subscription when no entitlement key is enough to express the failure. Existing codes, including `FORBIDDEN`, `RATE_LIMITED`, and `USAGE_LIMIT_EXCEEDED`, MUST retain their identifiers and meanings.

#### Scenario: Entitlement denial code

- **WHEN** a Nest route rejects a request because the caller's effective plan lacks a required entitlement or minimum rank
- **THEN** the error envelope carries `error.code` `ENTITLEMENT_DENIED`

#### Scenario: Inactive subscription code available

- **WHEN** a route rejects a request specifically because no entitled subscription is in force and the failure is classified as subscription inactivity
- **THEN** the error envelope carries `error.code` `SUBSCRIPTION_INACTIVE`

#### Scenario: Distinct from RBAC forbidden

- **WHEN** a client compares an entitlement denial to a missing-permission denial
- **THEN** the former uses `ENTITLEMENT_DENIED` (or `SUBSCRIPTION_INACTIVE`) and the latter uses `FORBIDDEN`

#### Scenario: Prior codes unchanged

- **WHEN** the error code set is inspected after plans and subscriptions are introduced
- **THEN** every code that existed before this change retains its identifier and meaning
