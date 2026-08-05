## ADDED Requirements

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
