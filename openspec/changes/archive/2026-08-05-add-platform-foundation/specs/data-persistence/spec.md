## ADDED Requirements

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

#### Scenario: Seed run on an empty database

- **WHEN** the seed command runs against a freshly migrated database
- **THEN** the baseline records are created and the command exits `0`

#### Scenario: Seed run twice

- **WHEN** the seed command runs a second time against the same database
- **THEN** it exits `0`, no duplicate records are created, and no unique-constraint error is raised

### Requirement: Baseline schema

The initial schema SHALL contain only what the platform foundation requires, with no model anticipating authentication, billing, plans, or credits.

The baseline MUST include at least one model, so the seed hook and persistence tests exercise a real write-and-read round trip rather than a connectivity ping.

#### Scenario: Persistence round trip

- **WHEN** an integration test writes a baseline record and reads it back
- **THEN** the value read equals the value written

#### Scenario: No speculative domain models

- **WHEN** the baseline schema is inspected
- **THEN** it contains no user, session, account, plan, subscription, or credit-ledger model

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
