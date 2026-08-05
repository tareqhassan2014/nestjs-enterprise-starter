# Developer Environment

## Purpose

What it takes to run, build, and verify this service: a one-command local stack, a production container image, module resolution that behaves identically across every tool, and the CI gates that enforce all of it on every change.

## Requirements

### Requirement: One-command local stack

The repository SHALL provide a Docker Compose stack running the application, PostgreSQL, and Redis, startable with a single command from a fresh clone after copying `.env.example` to `.env`.

Data services MUST declare healthchecks, and the application service MUST wait for them to report healthy before starting, so startup does not race an unready database. PostgreSQL data MUST persist across restarts via a named volume.

#### Scenario: Fresh clone brings the stack up

- **WHEN** a contributor copies `.env.example` to `.env` and starts the Compose stack
- **THEN** all three services start and the readiness endpoint returns `200`

#### Scenario: Application waits for dependencies

- **WHEN** the stack starts and PostgreSQL takes several seconds to accept connections
- **THEN** the application container starts only after PostgreSQL reports healthy, and does not crash-loop

#### Scenario: Restart preserves data

- **WHEN** the stack is stopped and started again
- **THEN** data written to PostgreSQL before the restart is still present

#### Scenario: Development mode with hot reload

- **WHEN** the stack is started with the development overlay and a source file is edited
- **THEN** the application reloads without rebuilding the image

### Requirement: Production container image

The repository SHALL provide a multi-stage `Dockerfile` producing a runtime image that contains only production dependencies, compiled output, and the generated database client.

The runtime image MUST run as a non-root user, MUST handle `SIGTERM` such that shutdown hooks execute, and MUST NOT contain development-only dependencies or source files.

#### Scenario: Image builds and runs

- **WHEN** the production image is built and started against a reachable database and Redis
- **THEN** the application boots and the readiness endpoint returns `200`

#### Scenario: Image contents

- **WHEN** the runtime image is inspected
- **THEN** it contains no development dependencies and no TypeScript sources

#### Scenario: Container receives SIGTERM

- **WHEN** the running container is stopped
- **THEN** the process runs its shutdown hooks and exits without being force-killed

### Requirement: Consistent path alias resolution

Path aliases SHALL be declared once in the TypeScript configuration and resolve identically under typecheck, build, unit tests, end-to-end tests, the seed script, and the compiled runtime artifact.

#### Scenario: Aliased import in application code

- **WHEN** a source file imports another module via a path alias
- **THEN** typecheck, unit tests, end-to-end tests, and the production build all resolve it

#### Scenario: Compiled output runs

- **WHEN** the built artifact is started directly with Node
- **THEN** all aliased imports resolve at runtime and the application boots

#### Scenario: Alias resolution regression

- **WHEN** an alias resolves during typecheck but not in the compiled output
- **THEN** the boot smoke test fails in CI rather than the regression reaching a release

### Requirement: CI quality gates

Continuous integration SHALL run on every push and pull request, executing lint, typecheck, unit tests, end-to-end tests, build, and a boot smoke test of the compiled artifact across the Node version matrix. Any failing gate MUST fail the pipeline.

A gate MAY be restricted to a subset of matrix cells only where a test-tooling limitation — not an application limitation — makes it unrunnable elsewhere. Each such restriction MUST be documented at the step with the limitation and the Node version that lifts it, and every gate the restriction skips MUST still run on at least one cell.

Tests requiring PostgreSQL or Redis MUST run against real service containers, not mocks. Dependencies MUST be installed from the committed lockfile without modifying it. The production container image MUST be built at least once per workflow as specified by the production image build requirement.

#### Scenario: Pull request opened

- **WHEN** a pull request is opened
- **THEN** the pipeline runs every gate on each matrix Node version — except gates documented as restricted by a test-tooling limitation — and reports its result on the pull request

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
- **THEN** the CI workflow runs lint, typecheck, build, and the boot smoke test on each matrix Node version, and the test suites on every cell able to run them

#### Scenario: Engines floor is included

- **WHEN** the CI matrix is inspected
- **THEN** it includes a Node 22.x job satisfying `engines.node` `>=22.12`

#### Scenario: Engines floor proves `require(esm)` works

- **WHEN** the floor cell cannot run a suite because the test runner, not the application, requires a newer Node
- **THEN** that cell still builds and boots the compiled artifact, exercising Node's unflagged `require(esm)` for the ESM-only auth dependency

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
