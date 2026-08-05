# Usage Limits

## Purpose

Daily and weekly Redis usage counters keyed by subject and feature, with fail-closed storage behaviour and envelope responses distinct from burst/per-minute throttling.

## Requirements

### Requirement: Daily and weekly usage counters

The system SHALL provide Redis-backed usage counters for declared feature identifiers over **daily** and **weekly** periods.

Counters MUST be keyed by feature, period, and subject. The subject MUST include the authenticated user. An optional organization subject dimension MUST be supported in the key scheme so a future multi-tenant model can enforce org-wide ceilings without redesigning keys.

Period boundaries MUST be UTC calendar day for daily limits and UTC ISO week for weekly limits, so reset times are deterministic and communicable to clients.

#### Scenario: Consume within daily and weekly ceilings

- **WHEN** an authenticated user successfully consumes a unit of a declared feature and both daily and weekly counts remain below configured ceilings
- **THEN** both counters increment and the consume operation succeeds

#### Scenario: Daily ceiling reached

- **WHEN** a user's daily counter for a feature has reached its configured ceiling
- **THEN** a further consume for that feature is rejected without incrementing past the ceiling

#### Scenario: Weekly ceiling reached while daily remains

- **WHEN** a user's weekly counter for a feature has reached its ceiling but the daily counter has not
- **THEN** a further consume is rejected for the weekly limit

#### Scenario: Organization dimension reserved

- **WHEN** a consume is invoked with both user and organization identifiers
- **THEN** both the user-scoped and organization-scoped counters for that feature and period are enforced, and exceeding either rejects the consume

#### Scenario: Organization omitted

- **WHEN** a consume is invoked with only a user identifier
- **THEN** only user-scoped counters are read and written

### Requirement: Feature catalogue and configured ceilings

Feature identifiers used in usage keys MUST come from a code-declared catalogue so callers cannot invent arbitrary unbounded feature strings at runtime without an explicit extension point.

Each feature MUST have configurable daily and weekly ceilings. When the caller has an effective plan with a persisted usage-limit matrix row for that feature, those matrix values MUST be used. Otherwise ceilings MUST come from validated application configuration, with documented defaults suitable for the starter.

#### Scenario: Unknown feature rejected

- **WHEN** application code attempts to consume a feature identifier outside the catalogue
- **THEN** the operation fails as a programming/configuration error rather than silently creating an unbounded counter namespace

#### Scenario: Ceiling from plan matrix

- **WHEN** an entitled user's effective plan defines a daily ceiling for a feature and the user reaches that count
- **THEN** further consumes for that feature that day are rejected at the plan matrix ceiling

#### Scenario: Ceiling from configuration fallback

- **WHEN** no plan matrix row applies for the caller's effective plan and feature, and a feature's daily ceiling is set via configuration
- **THEN** further consumes for that feature that day are rejected at the configured ceiling

### Requirement: Plan-aware ceiling resolution uses the resolved principal

Usage ceiling resolution for an authenticated consume MUST derive the effective plan from the same subscription/plan rules as the entitlements gate, using the already-known user id on the usage subject, without performing a separate session lookup.

#### Scenario: Pro user gets Pro ceilings

- **WHEN** a user with an entitled Pro subscription consumes a catalogue feature that has distinct Lite and Pro matrix values
- **THEN** the Pro daily and weekly ceilings are applied

#### Scenario: Lite fallback ceilings

- **WHEN** a user with no entitled subscription consumes a catalogue feature
- **THEN** the Lite plan's matrix ceilings apply when present, otherwise configuration defaults

### Requirement: Usage limit exceeded response

Exhausting a daily or weekly usage ceiling SHALL produce HTTP `429` with error code `USAGE_LIMIT_EXCEEDED` on enveloped routes, distinct from burst/per-minute `RATE_LIMITED`.

The response MUST include `Retry-After` indicating whole seconds until the exhausted period resets, and MUST include structured details naming at least the feature and the period that was exceeded.

#### Scenario: Daily quota exhausted on an enveloped route

- **WHEN** a Nest route or service rejects a request because the daily usage ceiling for a feature is exhausted
- **THEN** the response is `429` with `error.code` `USAGE_LIMIT_EXCEEDED`
- **AND** `Retry-After` reflects time until the next UTC day boundary
- **AND** `error.details` identifies the feature and the `day` period

#### Scenario: Distinct from throttle rate limit

- **WHEN** a client compares a Nest throttle rejection to a usage-ceiling rejection
- **THEN** the former uses `RATE_LIMITED` and the latter uses `USAGE_LIMIT_EXCEEDED`

### Requirement: Usage storage failure fails closed

When Redis is unavailable for a usage check or increment, the consume MUST fail rather than admitting unmetered usage. The failure MUST NOT be reported as `USAGE_LIMIT_EXCEEDED`.

#### Scenario: Redis down during consume

- **WHEN** Redis cannot serve a usage counter operation
- **THEN** the consume fails with `503` / `SERVICE_UNAVAILABLE` (or an equivalent non-quota error)
- **AND** the error code is not `USAGE_LIMIT_EXCEEDED`

### Requirement: Counters self-expire with the period

Usage keys MUST carry a TTL that ends the period so unused keys do not accumulate indefinitely and so a period rollover does not require a sweeper job.

#### Scenario: Key absent after period ends

- **WHEN** a daily usage key's period has ended and its TTL has elapsed
- **THEN** a subsequent consume starts a new counter at zero for the new period

### Requirement: Guard-chain and programmatic consume

Usage enforcement SHALL be available both as an optional route annotation for simple metered endpoints and as a programmatic service API for feature modules that must meter only successful billable work.

Usage checks that run as guards MUST execute after authentication, authorization, and request throttling, and MUST consume the already-resolved principal rather than re-resolving the session.

#### Scenario: Annotated route enforces usage

- **WHEN** a route is annotated for a catalogue feature and the caller's daily ceiling for that feature is exhausted
- **THEN** the response is `429` with `USAGE_LIMIT_EXCEEDED` and the handler does not execute

#### Scenario: Programmatic consume after success path

- **WHEN** a service successfully completes a billable unit and calls consume for that feature
- **THEN** the matching daily and weekly counters increment by one

#### Scenario: Principal not re-resolved

- **WHEN** a usage guard runs for an authenticated request
- **THEN** it reads the principal established by authentication and does not perform a separate session lookup
