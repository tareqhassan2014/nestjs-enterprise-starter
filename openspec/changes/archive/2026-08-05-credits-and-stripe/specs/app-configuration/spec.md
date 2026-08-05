## ADDED Requirements

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

#### Scenario: Example file lists new variables

- **WHEN** `.env.example` is compared to the schema after this change
- **THEN** every new Stripe and credits variable appears in `.env.example` with a purpose comment and placeholder secrets only
