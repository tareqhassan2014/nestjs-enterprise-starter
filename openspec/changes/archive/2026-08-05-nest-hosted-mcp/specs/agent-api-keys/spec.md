## ADDED Requirements

### Requirement: User-scoped API keys for agents

The system SHALL allow an authenticated user to create, list, and revoke personal API keys used by headless agents. Each key MUST belong to exactly one user.

On creation, the plaintext secret MUST be shown once to the caller and MUST NOT be stored. The system MUST persist only a one-way hash of the secret plus a non-secret public prefix used for lookup.

#### Scenario: Create returns plaintext once

- **WHEN** a session-authenticated user creates an API key
- **THEN** the success envelope includes the plaintext secret exactly once and a subsequent list of keys does not include the plaintext secret

#### Scenario: List shows metadata without secret

- **WHEN** the same user lists their API keys
- **THEN** each item includes id, name/label, prefix, creation time, and optional last-used time, and never the plaintext secret or hash

#### Scenario: Revoke prevents further use

- **WHEN** the user revokes a key and an MCP client later presents that key
- **THEN** authentication fails and no tool adapter runs

### Requirement: Bearer authentication resolves to application principal

MCP requests (and any other surfaces that opt into agent API key auth) MUST authenticate with `Authorization: Bearer <api_key>`. A valid key MUST resolve to the same application principal shape used by session authentication (at minimum the owning user id and the permission set derived from that user’s roles).

Invalid, missing, expired, or revoked keys MUST fail authentication. Verification MUST use the stored hash (constant-time compare) after prefix lookup.

#### Scenario: Valid key authenticates

- **WHEN** an MCP client presents a valid, non-revoked key as Bearer
- **THEN** the principal is the key’s owning user and subsequent pipeline stages see that principal

#### Scenario: Invalid key rejected

- **WHEN** an MCP client presents a malformed or unknown Bearer token
- **THEN** authentication fails and no tool adapter runs

#### Scenario: Better Auth session is not required on MCP

- **WHEN** an MCP client authenticates with only a valid API key and no session cookie
- **THEN** tool discovery and permitted tool calls succeed

### Requirement: Key management is session-gated on REST

API key create, list, and revoke operations SHALL be exposed as versioned, enveloped Nest routes under the authenticated account (or equivalent) surface. Those routes MUST require a Better Auth session (not an API key) and the appropriate self-management permission.

#### Scenario: Unauthenticated create rejected

- **WHEN** a client without a session calls the create-key route
- **THEN** the response is `401` with error code `UNAUTHORIZED`

#### Scenario: User cannot manage another user’s keys

- **WHEN** a session-authenticated user attempts to revoke a key id owned by a different user
- **THEN** the operation is denied (`403` or `404` without leaking ownership) and the key remains usable by its owner until that owner revokes it
