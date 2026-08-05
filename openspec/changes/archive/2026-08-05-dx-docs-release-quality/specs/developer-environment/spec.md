## ADDED Requirements

### Requirement: Five-minute first-run path

The README SHALL lead with a copy-pasteable first-run section that a contributor with Node, pnpm, and Docker installed can complete in about five minutes, ending with a successful readiness probe. The section MUST list the minimum commands (env copy, install, stack up, migrate, seed as required for a usable authz baseline, and health check) without requiring undocumented steps.

#### Scenario: Timed path reaches ready

- **WHEN** a contributor follows only the README five-minute first-run section on a clean machine with Docker installed
- **THEN** `GET /health/ready` returns success without needing steps from later README sections

#### Scenario: Seed requirement is stated

- **WHEN** a contributor reads the five-minute first-run section
- **THEN** it states that seeding is required before authorization-dependent flows work

### Requirement: Sample env sections are discoverable

The README SHALL explicitly point contributors to the `.env.example` sections (or equivalent headings) covering Google OAuth, Apple OAuth, Stripe top-up, and Redis so those integrations are discoverable from the first-run / configuration docs without a second sample env file.

#### Scenario: OAuth and Stripe pointers exist

- **WHEN** a contributor reads the first-run or configuration documentation
- **THEN** they are directed to `.env.example` guidance for Google, Apple, Stripe, and Redis

### Requirement: CI runs on a Node version matrix

Continuous integration SHALL execute the verify pipeline on more than one Node.js major version, including at least the repository engines floor (Node 22.x) and one newer supported major (Node 24.x or the then-current major at or above the floor). Any matrix cell failure MUST fail the workflow unless explicitly documented otherwise.

#### Scenario: Pull request runs multiple Node versions

- **WHEN** a pull request is opened
- **THEN** the CI workflow runs lint, typecheck, and tests on each matrix Node version

#### Scenario: Engines floor is included

- **WHEN** the CI matrix is inspected
- **THEN** it includes a Node 22.x job satisfying `engines.node` `>=22.12`

### Requirement: Production image build remains a CI gate

Continuous integration SHALL build the production multi-stage Docker image at least once per successful verify workflow (on the primary matrix cell is sufficient). Image build failure MUST fail the pipeline.

#### Scenario: Image build runs in CI

- **WHEN** the CI verify workflow completes its test and build gates on the primary Node version
- **THEN** it also runs a production image build and fails the workflow if that build fails

### Requirement: Release e2e coverage for auth, limits, credits, and billing webhook

The end-to-end (or integration) test suite run by CI MUST include scenarios that prove:

1. Authentication happy path (sign-up, email verification, sign-in)
2. Usage limit enforcement (request rejected with the enveloped usage-limit / rate outcome when the ceiling is exceeded)
3. Credits spend or guard behavior for a credit-costing path
4. Stripe billing webhook credit grant with signature verification (accept valid, reject invalid)

These suites MUST run against real PostgreSQL and Redis service containers in CI.

#### Scenario: Auth e2e is part of CI

- **WHEN** CI runs end-to-end tests
- **THEN** an authentication surface suite covering sign-up, verification, and sign-in executes

#### Scenario: Usage limits e2e is part of CI

- **WHEN** CI runs end-to-end tests
- **THEN** a usage-limits suite that asserts ceiling enforcement executes

#### Scenario: Credits and webhook e2e are part of CI

- **WHEN** CI runs end-to-end tests
- **THEN** suites covering credit spend/guard and signed Stripe webhook grant (plus invalid signature rejection) execute

## MODIFIED Requirements

### Requirement: Documented developer workflow

The README SHALL document first-run setup (including the five-minute path), the available scripts and Make targets, the database workflow, git hook expectations, and how to run the test suites.

Documentation MUST cover applying migrations, creating a new migration, seeding, and rolling back a migration applied to a shared database.

#### Scenario: New contributor follows the README

- **WHEN** a contributor follows the setup instructions on a clean machine with Docker installed
- **THEN** they reach a running application and passing test suite without needing undocumented steps

#### Scenario: Contributor changes the schema

- **WHEN** a contributor needs to add a table
- **THEN** the README states how to create, apply, and revert the migration

#### Scenario: Contributor learns about hooks and Make

- **WHEN** a contributor reads the developer workflow documentation
- **THEN** they find guidance for Makefile targets and for Husky / conventional commit expectations

### Requirement: CI quality gates

Continuous integration SHALL run on every push and pull request, executing lint, typecheck, unit tests, end-to-end tests, build, and a boot smoke test of the compiled artifact across the Node version matrix. Any failing gate MUST fail the pipeline.

Tests requiring PostgreSQL or Redis MUST run against real service containers, not mocks. Dependencies MUST be installed from the committed lockfile without modifying it. The production container image MUST be built at least once per workflow as specified by the production image build requirement.

#### Scenario: Pull request opened

- **WHEN** a pull request is opened
- **THEN** the pipeline runs every gate on each matrix Node version and reports its result on the pull request

#### Scenario: Lint failure

- **WHEN** a change introduces a lint error
- **THEN** the pipeline fails at the lint gate

#### Scenario: Integration tests need data services

- **WHEN** end-to-end tests run in CI
- **THEN** PostgreSQL and Redis service containers are available, migrated, and reachable

#### Scenario: Lockfile out of date

- **WHEN** `package.json` declares a dependency absent from the lockfile
- **THEN** installation fails rather than silently resolving and updating the lockfile

#### Scenario: Matrix cell failure fails the workflow

- **WHEN** lint, typecheck, or tests fail on any Node version in the matrix
- **THEN** the workflow is reported as failed
