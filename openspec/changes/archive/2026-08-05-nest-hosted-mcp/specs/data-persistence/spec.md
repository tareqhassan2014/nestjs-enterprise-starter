## ADDED Requirements

### Requirement: API key and MCP invocation persistence

The baseline schema SHALL include:

- An API key model related to the owning user, storing at minimum: id, user id, display name/label, public prefix, secret hash, optional last-used timestamp, creation timestamp, and revocation timestamp or equivalent soft-revoke marker.
- An MCP tool invocation model storing at minimum: id, user id, API key id, tool name, outcome, optional error code, optional correlation/request id, and creation timestamp.

Table names MUST follow the repository snake_case mapping convention. Indexes MUST support prefix lookup for authentication and recent-invocation queries by user and time.

#### Scenario: Migration adds API key table

- **WHEN** migrations are applied
- **THEN** the API key table exists with a foreign key to the user and a unique constraint suitable for prefix (or prefix+id) lookup

#### Scenario: Migration adds MCP invocation table

- **WHEN** migrations are applied
- **THEN** the MCP tool invocation table exists with indexes on user id and created-at (and/or API key id and created-at)

#### Scenario: Revoked key remains queryable

- **WHEN** a key is revoked
- **THEN** its row remains in the database with a revocation marker and authentication treats it as invalid
