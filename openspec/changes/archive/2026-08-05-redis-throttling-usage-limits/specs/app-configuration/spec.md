## ADDED Requirements

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
