## MODIFIED Requirements

### Requirement: Baseline schema

The schema SHALL contain the models required by the platform foundation, authentication, authorization, plans, and subscriptions. It MUST NOT introduce credit-ledger or Stripe-invoice models in this change.

Identity and access-control models remain in scope: the authentication library's user, session, account, verification, and two-factor models, plus the role, permission, role-to-permission mapping, and user-to-role assignment tables. Their **model names** MUST match what the authentication library queries, while their table names MUST follow the repository's existing snake_case convention through explicit mapping.

Plan and subscription models are now in scope: plan catalogue, per-plan entitlements, per-plan usage-limit matrices, and user subscriptions (including billing interval and lifecycle status). Credit-ledger and payment-object models remain forbidden until a dedicated billing/credits change.

The schema MUST retain at least one model unrelated to identity and billing, so the seed hook and persistence tests exercise a real write-and-read round trip independently of authentication.

#### Scenario: Persistence round trip

- **WHEN** an integration test writes a baseline record and reads it back
- **THEN** the value read equals the value written

#### Scenario: No speculative credit or payment models

- **WHEN** the schema is inspected
- **THEN** it contains no credit-ledger, wallet, invoice, or Stripe customer/payment-intent model as a required domain table

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

### Requirement: Idempotent seed hook

The repository SHALL provide a seed entry point, invocable through the standard Prisma seed command, that is safe to run repeatedly against the same database.

Seeding MUST use upsert semantics rather than unconditional inserts, and MUST resolve path aliases identically to application code.

Seeding establishes the access-control baseline (permission catalogue and baseline roles with mappings) and the commercial baseline (plans, per-plan entitlements, and per-plan usage-limit matrices). Idempotency for these MUST rest on database uniqueness constraints rather than on seed-script bookkeeping, so a concurrent or repeated run cannot produce duplicate mappings or duplicate plan matrix rows.

#### Scenario: Seed run on an empty database

- **WHEN** the seed command runs against a freshly migrated database
- **THEN** the baseline records, the permission catalogue, the baseline roles, the plan catalogue, plan entitlements, and plan usage-limit matrices are created and the command exits `0`

#### Scenario: Seed run twice

- **WHEN** the seed command runs a second time against the same database
- **THEN** it exits `0`, no duplicate records are created, and no unique-constraint error is raised

#### Scenario: Catalogue matches the code declaration

- **WHEN** the seed completes
- **THEN** the persisted permission catalogue contains exactly the permission identifiers declared in code

#### Scenario: Plan matrices match code catalogues

- **WHEN** the seed completes
- **THEN** every seeded plan has entitlement rows for every declared entitlement identifier and usage-limit rows for every declared usage feature

#### Scenario: Seed run after a permission is added in code

- **WHEN** a new permission identifier is declared in code and the seed is re-run against a populated database
- **THEN** the new identifier is added, existing rows are unchanged, and no duplicate mapping is created

#### Scenario: Duplicate mapping prevented by the database

- **WHEN** a role-to-permission mapping that already exists is seeded again
- **THEN** the database's uniqueness constraint makes the operation a no-op rather than an error or a duplicate
