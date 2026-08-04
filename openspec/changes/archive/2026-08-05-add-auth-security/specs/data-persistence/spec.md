## MODIFIED Requirements

### Requirement: Baseline schema

The schema SHALL contain only what the platform foundation and the authentication and authorization capabilities require, with no model anticipating billing, plans, or credits.

Identity and access-control models are now in scope: the authentication library's user, session, account, verification, and two-factor models, plus the role, permission, role-to-permission mapping, and user-to-role assignment tables. Their **model names** MUST match what the authentication library queries, while their table names MUST follow the repository's existing snake_case convention through explicit mapping.

The schema MUST retain at least one model unrelated to identity, so the seed hook and persistence tests exercise a real write-and-read round trip independently of authentication.

#### Scenario: Persistence round trip

- **WHEN** an integration test writes a baseline record and reads it back
- **THEN** the value read equals the value written

#### Scenario: No speculative domain models

- **WHEN** the schema is inspected
- **THEN** it contains no plan, subscription, entitlement, or credit-ledger model

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

Seeding now also establishes the access-control baseline: the permission catalogue declared in code, and the baseline roles with their permission mappings. Idempotency for these MUST rest on database uniqueness constraints rather than on seed-script bookkeeping, so a concurrent or repeated run cannot produce duplicate mappings.

#### Scenario: Seed run on an empty database

- **WHEN** the seed command runs against a freshly migrated database
- **THEN** the baseline records, the permission catalogue, and the baseline roles are created and the command exits `0`

#### Scenario: Seed run twice

- **WHEN** the seed command runs a second time against the same database
- **THEN** it exits `0`, no duplicate records are created, and no unique-constraint error is raised

#### Scenario: Catalogue matches the code declaration

- **WHEN** the seed completes
- **THEN** the persisted permission catalogue contains exactly the permission identifiers declared in code

#### Scenario: Seed run after a permission is added in code

- **WHEN** a new permission identifier is declared in code and the seed is re-run against a populated database
- **THEN** the new identifier is added, existing rows are unchanged, and no duplicate mapping is created

#### Scenario: Duplicate mapping prevented by the database

- **WHEN** a role-to-permission mapping that already exists is seeded again
- **THEN** the database's uniqueness constraint makes the operation a no-op rather than an error or a duplicate
