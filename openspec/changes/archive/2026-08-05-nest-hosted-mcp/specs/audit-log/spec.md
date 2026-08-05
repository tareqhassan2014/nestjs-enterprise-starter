## ADDED Requirements

### Requirement: MCP tool invocation audit log

The system SHALL persist an append-only record for MCP tool invocations after authentication succeeds (including policy denials and handler errors), capturing at minimum: acting user id, API key id, tool name, outcome (`success`, `denied`, or `error`), optional error/code identifier, optional request/correlation id, and creation timestamp.

Application APIs MUST NOT update or delete these rows. High-volume successful reads MAY be retained with the same immutability rules; retention/TTL policy MAY be documented separately but MUST NOT allow in-place mutation.

#### Scenario: Successful tool call is recorded

- **WHEN** an authenticated agent successfully invokes a catalogued tool
- **THEN** an invocation row exists with matching user id, API key id, tool name, and outcome `success`

#### Scenario: Permission denial is recorded

- **WHEN** an authenticated agent invokes a tool without the required permission
- **THEN** an invocation row exists with outcome `denied` and the adapter did not run

#### Scenario: Unauthenticated attempts need not be persisted

- **WHEN** a client invokes MCP without a valid API key
- **THEN** persistence of an invocation row is not required

#### Scenario: Invocation rows are immutable via API

- **WHEN** a client attempts to modify or delete an MCP invocation row through an application HTTP API
- **THEN** no such mutating route exists (or the attempt is rejected), and existing rows remain unchanged

### Requirement: Admin audit log remains for privileged admin mutations

Existing admin-mutation audit requirements for privileged admin REST actions remain in force. MCP tool invocation records are a separate append-only stream and MUST NOT replace admin credit-adjust audit rows.

#### Scenario: Admin credit adjust still writes admin audit

- **WHEN** an admin successfully adjusts another user's credits via the admin HTTP API
- **THEN** an admin audit row is written as specified by the admin audit requirements, independent of MCP invocation logging
