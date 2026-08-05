## ADDED Requirements

### Requirement: Error codes for credit outcomes

The error code set SHALL include stable identifiers for credit denials that clients must branch on, distinct from RBAC, plan entitlements, throttling, and usage limits.

The set MUST include `INSUFFICIENT_CREDITS` for wallet balance below a required feature cost. Existing codes, including `FORBIDDEN`, `ENTITLEMENT_DENIED`, `RATE_LIMITED`, and `USAGE_LIMIT_EXCEEDED`, MUST retain their identifiers and meanings.

#### Scenario: Insufficient credits code

- **WHEN** a Nest route rejects a request because the caller's credit balance is below the required cost
- **THEN** the error envelope carries `error.code` `INSUFFICIENT_CREDITS`

#### Scenario: Distinct from entitlement denial

- **WHEN** a client compares an insufficient-credits denial to a missing-entitlement denial
- **THEN** the former uses `INSUFFICIENT_CREDITS` and the latter uses `ENTITLEMENT_DENIED`

#### Scenario: Prior codes unchanged

- **WHEN** the error code set is inspected after credits are introduced
- **THEN** every code that existed before this change retains its identifier and meaning
