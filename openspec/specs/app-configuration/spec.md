# Application Configuration

## Purpose

How the application learns its environment: every variable validated before the server binds a port, exposed through typed namespaces, and documented in a contract that cannot silently drift.

A misconfigured deployment fails loudly at boot with every problem listed at once, rather than failing later on the first request that happens to need the missing value.

## Requirements

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

### Requirement: Conditionally required configuration groups

The schema SHALL support configuration values that are required as a *group*: absent entirely is valid and disables the associated feature, while a partially supplied group MUST fail validation at boot naming the missing members.

Where a feature's availability is determined by such a group, that availability MUST be **derived** from the group's presence rather than declared by a separate enable flag, so configuration cannot contradict itself.

Validation MUST report a half-configured group at boot rather than deferring the failure to the first request that needs the missing value.

#### Scenario: Group absent entirely

- **WHEN** none of an optional provider's credentials are supplied
- **THEN** validation passes and the provider is not enabled

#### Scenario: Group complete

- **WHEN** every member of a provider's credential group is supplied
- **THEN** validation passes and the provider is enabled without any additional flag

#### Scenario: Group partially supplied

- **WHEN** a provider's client identifier is supplied but its secret is not
- **THEN** validation fails, the error names the missing variable and the group it belongs to, and no port is bound

#### Scenario: No contradictory enable flag

- **WHEN** the configuration schema is inspected
- **THEN** no variable exists that could enable a provider whose credentials are absent, or disable one whose credentials are present

#### Scenario: Multiple groups reported together

- **WHEN** two separate provider groups are each half-configured
- **THEN** both are reported in the single aggregated validation error

### Requirement: Throttle and usage-limit configuration

The environment schema SHALL declare validated variables for Nest throttle windows and ceilings (global burst, global per-minute, and the stricter account-route policy) and for daily and weekly usage ceilings for each catalogue feature (or a documented default applied to features without an override).

All such values MUST be exposed through typed configuration namespaces. Boot MUST reject non-positive limits. `.env.example` MUST document each new variable.

#### Scenario: Valid throttle configuration boots

- **WHEN** the process starts with positive burst and per-minute limit and window values
- **THEN** validation passes and the throttling module receives those coerced numbers

#### Scenario: Non-positive throttle limit rejected

- **WHEN** a throttle maximum is set to `0` or a negative number
- **THEN** validation fails before the HTTP server binds a port and the error names the offending variable

#### Scenario: Usage ceilings in typed config

- **WHEN** a consumer injects the usage-limits configuration namespace
- **THEN** daily and weekly ceilings are numbers already coerced from the environment

#### Scenario: Example file lists new variables

- **WHEN** `.env.example` is compared to the schema after this change
- **THEN** every new throttle and usage variable appears in `.env.example` with a purpose comment

### Requirement: Stripe and credits configuration

The environment schema SHALL declare a conditionally required Stripe top-up credential group (secret key, webhook signing secret, and pack/price configuration, plus any success/cancel URL inputs not derived elsewhere) and optional credits settings such as a low-balance threshold.

When the Stripe group is absent entirely, validation MUST pass and Stripe top-up MUST be treated as disabled. When the group is partially supplied, validation MUST fail at boot naming the missing members. When complete, values MUST be exposed through a typed configuration namespace. Secrets MUST NOT appear with real values in `.env.example`.

Optional credits settings (for example low-balance threshold) MUST be validated when present (non-negative integer) and documented in `.env.example`.

#### Scenario: Stripe group absent boots with top-up disabled

- **WHEN** none of the Stripe top-up group variables are supplied
- **THEN** validation passes and Stripe top-up is not enabled

#### Scenario: Stripe group complete enables top-up config

- **WHEN** every member of the Stripe top-up group is supplied with valid values
- **THEN** validation passes and the billing/Stripe namespace exposes those coerced values

#### Scenario: Partial Stripe group rejected

- **WHEN** a Stripe secret key is supplied without the webhook signing secret (or another required group member)
- **THEN** validation fails before the HTTP server binds a port and the error names the missing variable and its group

#### Scenario: Example file lists Stripe and credits variables

- **WHEN** `.env.example` is compared to the schema after Stripe/credits configuration is introduced
- **THEN** every new Stripe and credits variable appears in `.env.example` with a purpose comment and placeholder secrets only

### Requirement: Environment-dependent configuration constraints

The schema SHALL be able to reject a value that is valid in one environment and unsafe in another, and MUST do so at boot.

Where a setting is safe for development but would cause silent data loss or a security weakness in production, validation MUST fail in production rather than rely on an operator noticing.

#### Scenario: Non-delivering mail transport in production

- **WHEN** the application starts in the production environment with a mail transport that records instead of delivering
- **THEN** validation fails, the error explains why a delivering transport is required, and no port is bound

#### Scenario: Same value accepted in development

- **WHEN** the application starts in development with that same transport configured
- **THEN** validation passes

#### Scenario: Mutually incompatible values rejected

- **WHEN** a wildcard cross-origin value is configured while credentialed cross-origin access is in effect
- **THEN** validation fails, because browsers reject the combination and the intent cannot be honoured

### Requirement: Environment-specific defaults

The schema SHALL define `NODE_ENV` as one of `development`, `test`, or `production`, defaulting to `development`, and SHALL apply defaults only to variables that are safe to default.

Secrets and connection strings MUST NOT have defaults. An unconditionally required secret's absence MUST fail validation in every environment.

A secret belonging to a conditionally required group is exempt from the absence rule only as a whole group: the group may be absent, but no member of it may be defaulted, and a partially supplied group MUST fail validation. Secrets MUST NOT acquire a default value by virtue of being optional.

#### Scenario: Optional variable omitted

- **WHEN** `LOG_LEVEL` is not set
- **THEN** validation passes and the configured level is the documented default

#### Scenario: Secret omitted

- **WHEN** `DATABASE_URL` is not set in any environment
- **THEN** validation fails and the application does not start

#### Scenario: Authentication signing secret omitted

- **WHEN** the authentication signing secret is not set in any environment
- **THEN** validation fails and the application does not start

#### Scenario: Optional group member has no default

- **WHEN** the schema is inspected for a conditionally required credential group
- **THEN** no member of that group carries a default value
