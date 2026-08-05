# Admin Billing

## Purpose

Admin-permission-gated inspection of another user's subscription and credits, plus privileged credit grant/adjust mutations that delegate to the credit domain service and write audit records.

## Requirements

### Requirement: Admin subscription inspection for another user

The system SHALL expose an admin-permission-gated, enveloped read of another user's effective plan and subscription fields under `/api/v1/admin`, requiring `admin:subscriptions:read`.

The response MUST use the same effective-plan resolution rules as the caller's self-service current-plan surface. It MUST NOT be available to callers who only hold end-user account permissions.

#### Scenario: Admin reads another user's effective plan

- **WHEN** a caller with `admin:subscriptions:read` requests the admin subscription view for a user id
- **THEN** the success envelope describes that user's effective plan slug and subscription status/interval when a subscription row exists

#### Scenario: Missing user

- **WHEN** an admin requests a subscription view for a user id that does not exist
- **THEN** the response is `404` with error code `NOT_FOUND`

#### Scenario: End user cannot read another subscription

- **WHEN** an authenticated user without `admin:subscriptions:read` requests another user's admin subscription view
- **THEN** the response is `403` with error code `FORBIDDEN`

### Requirement: Admin credit wallet and ledger inspection

The system SHALL expose an admin-permission-gated, enveloped read of another user's credit balance and a capped recent ledger page, requiring `admin:credits:read`.

#### Scenario: Admin reads wallet and ledger

- **WHEN** a caller with `admin:credits:read` requests credits for a user id
- **THEN** the success envelope includes the balance and a bounded list of recent ledger entries for that user

#### Scenario: Page size is capped

- **WHEN** an admin requests a ledger page larger than the server maximum
- **THEN** the server applies the maximum page size rather than returning an unbounded result set

### Requirement: Admin credit grant and adjust

The system SHALL expose admin-permission-gated, enveloped mutation endpoints to grant credits and to apply a signed adjust delta for another user, requiring `admin:credits:adjust`.

Mutations MUST delegate to the existing credit domain service so ledger immutability, non-negative balance rules, and idempotency keys remain authoritative. Each successful mutation MUST record an admin audit entry naming the actor, action, target user, reason, and request correlation id when available.

#### Scenario: Admin grant increases balance

- **WHEN** a caller with `admin:credits:adjust` posts a grant with a positive amount, idempotency key, and reason for a user
- **THEN** the user's balance increases by that amount, a `grant` ledger entry exists, and an admin audit record for the grant exists

#### Scenario: Admin adjust debit

- **WHEN** a caller with `admin:credits:adjust` posts a negative adjust delta with a new idempotency key and the wallet has sufficient balance
- **THEN** the balance decreases, an `adjust` ledger entry exists, and an admin audit record exists

#### Scenario: Idempotent replay

- **WHEN** the same admin grant or adjust idempotency key is submitted twice with the same logical payload
- **THEN** the balance reflects a single application and a second ledger entry is not created

#### Scenario: Adjust without permission denied

- **WHEN** a caller with `admin:credits:read` but not `admin:credits:adjust` attempts an adjust
- **THEN** the response is `403` with error code `FORBIDDEN` and the wallet is unchanged

#### Scenario: Reason required

- **WHEN** an adjust or grant is submitted without a reason
- **THEN** the response is a validation error and no ledger mutation occurs
