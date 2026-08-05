## ADDED Requirements

### Requirement: Metrics and OpenAPI exposure configuration

The environment schema SHALL declare validated configuration for metrics scrape enablement, an optional metrics bearer token, OpenAPI/Swagger UI enablement, and any admin dashboard defaults such as top-N size for 429 leaderboards.

`.env.example` MUST document these variables with non-secret defaults or placeholders. Real scrape tokens MUST NOT be committed.

#### Scenario: Metrics disabled by default in example

- **WHEN** a contributor copies `.env.example` without enabling metrics
- **THEN** environment validation passes and the metrics scrape path does not expose series unless explicitly enabled

#### Scenario: Swagger flag is validated

- **WHEN** `SWAGGER_ENABLED` (or the chosen equivalent) is set to a non-boolean value
- **THEN** boot fails naming that variable

#### Scenario: Bearer token placeholder only

- **WHEN** `.env.example` is inspected for the metrics token variable
- **THEN** it contains a placeholder or empty value, not a production secret
