## MODIFIED Requirements

### Requirement: Baseline schema

The schema SHALL contain the models required by the platform foundation, authentication, authorization, plans, subscriptions, credits, and Stripe top-up linkage. Speculative models beyond that set (for example Connect accounts, Tax registrations, or invoice PDFs as domain tables) MUST NOT be introduced in this change.

Identity and access-control models remain in scope: the authentication library's user, session, account, verification, and two-factor models, plus the role, permission, role-to-permission mapping, and user-to-role assignment tables. Their **model names** MUST match what the authentication library queries, while their table names MUST follow the repository's existing snake_case convention through explicit mapping.

Plan and subscription models remain in scope: plan catalogue, per-plan entitlements, per-plan usage-limit matrices, and user subscriptions (including billing interval and lifecycle status).

Credit and Stripe top-up models are now in scope: per-user credit wallet, immutable credit ledger entries with unique idempotency keys, Stripe Customer linkage, and processed Stripe event (or equivalent) dedupe storage needed for idempotent webhooks.

The schema MUST retain at least one model unrelated to identity and billing, so the seed hook and persistence tests exercise a real write-and-read round trip independently of authentication.

#### Scenario: Persistence round trip

- **WHEN** an integration test writes a baseline record and reads it back
- **THEN** the value read equals the value written

#### Scenario: Credit and Stripe top-up models present

- **WHEN** the schema is inspected
- **THEN** it declares credit wallet, credit ledger, Stripe customer linkage, and Stripe processed-event (or equivalent webhook idempotency) models with uniqueness on wallet user, ledger idempotency key, and Stripe customer / event identifiers as designed

#### Scenario: Plan and subscription models present

- **WHEN** the schema is inspected
- **THEN** it declares plan, plan-entitlement, plan-usage-limit, and subscription models with uniqueness constraints on plan slug, plan-entitlement pairs, and plan-feature usage-limit pairs

#### Scenario: Identity models present

- **WHEN** the schema is inspected
- **THEN** it declares the user, session, account, verification, and two-factor models the authentication library expects, under the model names it queries

#### Scenario: Access-control models present

- **WHEN** the schema is inspected
- **THEN** it declares role, permission, role-to-permission mapping, and user-to-role assignment models, and the mapping and assignment tables each carry a composite uniqueness constraint

#### Scenario: Table naming convention holds

- **WHEN** the generated migration is inspected
- **THEN** every new table name is snake_case, consistent with the existing tables

#### Scenario: No speculative Connect or Tax domain tables

- **WHEN** the schema is inspected
- **THEN** it contains no Stripe Connect account, Tax registration, or invoice-PDF domain table as a required model of this change
