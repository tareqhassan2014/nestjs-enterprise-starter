## ADDED Requirements

### Requirement: Environment validation at boot

The application SHALL validate the full environment against a schema before the HTTP server binds a port, and SHALL refuse to start when validation fails.

Validation failures MUST report every invalid or missing variable in a single error, not the first failure only. The error MUST name each offending variable and state what was expected.

#### Scenario: All required variables present and well-formed

- **WHEN** the process starts with a complete, valid environment
- **THEN** validation passes, the application bootstraps, and the HTTP server listens on the configured port

#### Scenario: Multiple variables missing or invalid

- **WHEN** the process starts with `DATABASE_URL` absent and `PORT` set to `"not-a-number"`
- **THEN** the process exits with a non-zero code before binding a port
- **AND** the emitted error names both `DATABASE_URL` and `PORT` with the reason each failed

#### Scenario: Unknown extra variables present

- **WHEN** the environment contains variables the schema does not declare
- **THEN** validation passes and the extra variables are ignored

### Requirement: Typed configuration access

Application code SHALL read configuration only through typed, namespaced configuration providers. Reading `process.env` directly outside the configuration layer SHALL be rejected by lint.

Each namespace MUST expose values already coerced to their declared runtime types, so no consumer parses, casts, or non-null-asserts a configuration value.

#### Scenario: Consumer injects a configuration namespace

- **WHEN** a provider injects the `app` configuration namespace and reads the port
- **THEN** the value is a `number`, typed without assertion, matching the validated environment

#### Scenario: Numeric variable supplied as a string

- **WHEN** `PORT` is supplied as the string `"8080"`
- **THEN** the `app` namespace exposes it as the number `8080`

#### Scenario: Direct process.env access is introduced

- **WHEN** a file outside the configuration layer reads `process.env` directly
- **THEN** `pnpm lint` reports an error identifying that file

### Requirement: Documented environment contract

The repository SHALL ship an `.env.example` that lists every variable the schema declares, and CI SHALL fail when the two drift.

`.env.example` MUST carry non-secret defaults suitable for the Docker Compose stack, placeholder values for secrets, and a comment per variable stating its purpose. It MUST NOT contain real credentials.

#### Scenario: Fresh clone uses the example file

- **WHEN** a contributor copies `.env.example` to `.env` and runs the Docker Compose stack without editing any value
- **THEN** environment validation passes and the application starts

#### Scenario: A variable is added to the schema but not the example

- **WHEN** a new required variable is added to the schema and `.env.example` is not updated
- **THEN** the CI drift check fails and names the missing variable

### Requirement: Environment-specific defaults

The schema SHALL define `NODE_ENV` as one of `development`, `test`, or `production`, defaulting to `development`, and SHALL apply defaults only to variables that are safe to default.

Secrets and connection strings MUST NOT have defaults — their absence MUST fail validation in every environment.

#### Scenario: Optional variable omitted

- **WHEN** `LOG_LEVEL` is not set
- **THEN** validation passes and the configured level is the documented default

#### Scenario: Secret omitted

- **WHEN** `DATABASE_URL` is not set in any environment
- **THEN** validation fails and the application does not start
