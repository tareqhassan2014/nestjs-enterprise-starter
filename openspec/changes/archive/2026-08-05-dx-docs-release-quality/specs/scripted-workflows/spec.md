## ADDED Requirements

### Requirement: Root Makefile wraps package scripts

The repository SHALL provide a root `Makefile` whose targets invoke the existing package-manager scripts (and Compose/Docker commands already defined by the project). Make MUST NOT become a second source of business logic; each target SHALL shell out to a named script or documented Docker invocation.

#### Scenario: Stack comes up via Make

- **WHEN** a contributor runs the Make target for starting the local stack
- **THEN** the same Compose stack used by the pnpm docker-up script starts

#### Scenario: Tests run via Make

- **WHEN** a contributor runs the Make targets for unit and e2e tests
- **THEN** the corresponding `pnpm test` and `pnpm test:e2e` (or equivalent) commands execute

### Requirement: Common workflow targets exist

The Makefile SHALL expose targets covering at least: stack up/down (and logs if already scripted), database migrate and seed, lint, typecheck, unit tests, e2e tests, production build, boot smoke test, and production image build.

#### Scenario: Help or default lists targets

- **WHEN** a contributor runs `make` or `make help`
- **THEN** available targets (or a short usage summary) are shown without failing the stack

#### Scenario: Image build target exists

- **WHEN** a contributor runs the Make image-build target
- **THEN** the production multi-stage image build runs successfully against the repository Dockerfile

### Requirement: Scripts remain the source of truth

Package.json scripts (or equivalent) MUST remain callable directly. Documentation MAY prefer Make for brevity but MUST NOT remove or hide the underlying pnpm script names from the Scripts table (or equivalent).

#### Scenario: pnpm script still works without Make

- **WHEN** a contributor runs `pnpm test` without using Make
- **THEN** unit tests run the same as the Make test target’s underlying command
