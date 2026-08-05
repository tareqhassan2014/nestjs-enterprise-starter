## ADDED Requirements

### Requirement: Organization, idempotency, and flag override persistence

The Prisma schema SHALL include models (or equivalent tables) for organizations and membership, HTTP idempotency records with expiry and uniqueness suitable for safe POST retries, and optional feature-flag overrides. Credit wallet and subscription ownership MUST allow organization owners without breaking existing user-owned rows.

Migrations MUST be versioned and apply cleanly on top of the current schema. Seed MAY create no organizations by default.

#### Scenario: Migration adds org tables

- **WHEN** migrations are applied to a database that already has user credit wallets
- **THEN** organization and membership tables exist and existing user wallets remain valid

#### Scenario: Idempotency key uniqueness

- **WHEN** two idempotency records are inserted with the same principal and key while both are unexpired
- **THEN** the database rejects the duplicate

#### Scenario: Org wallet coexists with user wallet

- **WHEN** a user wallet and an organization wallet both exist
- **THEN** each row has exactly one owner kind and ledger entries reference the matching owner
