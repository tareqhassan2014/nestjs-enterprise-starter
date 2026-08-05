# Data Persistence

## Purpose

PostgreSQL access through Prisma: connections bound to the application lifecycle, schema changes expressed as committed migrations, an idempotent seed hook, and database errors mapped onto the API error contract in one place instead of per feature.

## Requirements

### Requirement: Lifecycle-bound database client

The application SHALL expose a single Prisma-backed database client as an injectable provider, connecting during module initialization and disconnecting on shutdown.

Connection failure at startup MUST fail the bootstrap, so an unreachable or misconfigured database surfaces immediately rather than on the first request.

#### Scenario: Valid database URL

- **WHEN** the application starts with a reachable `DATABASE_URL`
- **THEN** the client connects during initialization and is injectable by any module

#### Scenario: Unreachable database at startup

- **WHEN** the application starts with a `DATABASE_URL` pointing at an unreachable host
- **THEN** bootstrap fails with an error naming the connection failure, and the process exits non-zero

#### Scenario: Shutdown

- **WHEN** the application shuts down
- **THEN** the database connection is closed before the process exits

### Requirement: Versioned migrations

Database schema changes SHALL be expressed as committed, versioned migration files. The schema MUST NOT be applied by pushing state directly in any non-local environment.

Migrations MUST NOT run automatically as part of application startup, so concurrent replicas cannot race the same migration.

#### Scenario: Fresh database

- **WHEN** migrations are applied to an empty database
- **THEN** the schema is created and the migration history table records each applied migration

#### Scenario: Migrations already applied

- **WHEN** the migration command runs against a database already at the latest migration
- **THEN** no changes are made and the command succeeds

#### Scenario: Application starts with pending migrations

- **WHEN** the application boots against a database with unapplied migrations
- **THEN** no migration is applied automatically by the application process

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

### Requirement: Baseline schema

The schema SHALL contain the models required by the platform foundation, authentication, authorization, plans, subscriptions, credits, and Stripe top-up linkage. Speculative models beyond that set (for example Connect accounts, Tax registrations, or invoice PDFs as domain tables) MUST NOT be introduced as required domain tables of this capability set.

Identity and access-control models remain in scope: the authentication library's user, session, account, verification, and two-factor models, plus the role, permission, role-to-permission mapping, and user-to-role assignment tables. Their **model names** MUST match what the authentication library queries, while their table names MUST follow the repository's existing snake_case convention through explicit mapping.

Plan and subscription models remain in scope: plan catalogue, per-plan entitlements, per-plan usage-limit matrices, and user subscriptions (including billing interval and lifecycle status).

Credit and Stripe top-up models are in scope: per-user credit wallet, immutable credit ledger entries with unique idempotency keys, Stripe Customer linkage, and processed Stripe event (or equivalent) dedupe storage needed for idempotent webhooks.

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
- **THEN** it contains no Stripe Connect account, Tax registration, or invoice-PDF domain table as a required model of this capability set

### Requirement: Database errors surface through the error envelope

Known database errors SHALL be translated into the application's standard error envelope with appropriate codes and HTTP statuses, centrally rather than per feature module.

Raw database error text, SQL, and connection strings MUST NOT reach the client.

#### Scenario: Unique constraint violated

- **WHEN** a write violates a unique constraint
- **THEN** the response is `409` with error code `CONFLICT`

#### Scenario: Record not found

- **WHEN** an operation targets a record that does not exist
- **THEN** the response is `404` with error code `NOT_FOUND`

#### Scenario: Unmapped database error

- **WHEN** a database error with no explicit mapping is raised
- **THEN** the response is `500` with code `INTERNAL_ERROR` and the raw error text is logged, not returned
