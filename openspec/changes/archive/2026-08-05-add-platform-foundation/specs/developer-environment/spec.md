## ADDED Requirements

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

Continuous integration SHALL run on every push and pull request, executing lint, typecheck, unit tests, end-to-end tests, build, and a boot smoke test of the compiled artifact. Any failing gate MUST fail the pipeline.

Tests requiring PostgreSQL or Redis MUST run against real service containers, not mocks. Dependencies MUST be installed from the committed lockfile without modifying it.

#### Scenario: Pull request opened

- **WHEN** a pull request is opened
- **THEN** the pipeline runs every gate and reports its result on the pull request

#### Scenario: Lint failure

- **WHEN** a change introduces a lint error
- **THEN** the pipeline fails at the lint gate

#### Scenario: Integration tests need data services

- **WHEN** end-to-end tests run in CI
- **THEN** PostgreSQL and Redis service containers are available, migrated, and reachable

#### Scenario: Lockfile out of date

- **WHEN** `package.json` declares a dependency absent from the lockfile
- **THEN** installation fails rather than silently resolving and updating the lockfile

### Requirement: Documented developer workflow

The README SHALL document first-run setup, the available scripts, the database workflow, and how to run the test suites.

Documentation MUST cover applying migrations, creating a new migration, seeding, and rolling back a migration applied to a shared database.

#### Scenario: New contributor follows the README

- **WHEN** a contributor follows the setup instructions on a clean machine with Docker installed
- **THEN** they reach a running application and passing test suite without needing undocumented steps

#### Scenario: Contributor changes the schema

- **WHEN** a contributor needs to add a table
- **THEN** the README states how to create, apply, and revert the migration
