## ADDED Requirements

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

## MODIFIED Requirements

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
