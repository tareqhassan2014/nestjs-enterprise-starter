# Audit Log

## Purpose

Append-only audit records for privileged admin mutations, with an admin-permission-gated list/filter API for operators to review actor, action, target, and reason.

## Requirements

### Requirement: Append-only admin action audit log

The system SHALL persist an append-only audit record for privileged admin mutations exposed by the admin monitoring surface (at minimum credit grant and credit adjust).

Each record MUST capture the actor user id, action identifier, target type and target id when applicable, a human-readable summary (including the operator reason), optional structured metadata, the request correlation id when available, and a creation timestamp.

Application APIs MUST NOT update or delete audit rows.

#### Scenario: Credit adjust writes an audit row

- **WHEN** an admin successfully adjusts another user's credits
- **THEN** an audit row exists with action identifying credit adjust, the actor id, the target user id, and the supplied reason

#### Scenario: Failed mutation does not write success audit

- **WHEN** an admin adjust is rejected for insufficient balance or validation failure
- **THEN** no success audit row for that adjust is required to be written

#### Scenario: Audit rows are immutable via API

- **WHEN** a client attempts to modify or delete an audit row through an application HTTP API
- **THEN** no such mutating route exists (or the attempt is rejected), and existing rows remain unchanged

### Requirement: Admin audit read API

The system SHALL expose an admin-permission-gated, enveloped list/filter API for audit records requiring `admin:audit:read`.

Filtering MUST support at least time range and action, and SHOULD support actor and target id. Results MUST be paginated with a hard maximum page size.

#### Scenario: Admin lists recent audit entries

- **WHEN** a caller with `admin:audit:read` requests the audit list
- **THEN** the success envelope returns a bounded page of audit records ordered by newest first

#### Scenario: Filter by action

- **WHEN** an admin lists audit entries filtered to credit adjust actions
- **THEN** returned rows match that action and do not include unrelated actions

#### Scenario: Non-admin denied

- **WHEN** an authenticated user without `admin:audit:read` requests the audit list
- **THEN** the response is `403` with error code `FORBIDDEN`

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
