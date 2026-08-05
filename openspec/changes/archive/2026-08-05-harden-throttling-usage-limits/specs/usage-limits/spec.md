## MODIFIED Requirements

### Requirement: Daily and weekly usage counters

The system SHALL provide Redis-backed usage counters for declared feature identifiers over **daily** and **weekly** periods.

Counters MUST be keyed by feature, period, and subject. A usage subject SHALL name the acting member, and MAY additionally name an organization the request is bound to; when it does, that organization MUST be represented by the same resolved billing subject the credit and plan capabilities consume, rather than by a parallel organization identifier of its own.

Both dimensions are required because usage answers two questions — who acted, and whose quota was spent — where a credit debit answers only the second. The acting member's ceiling MUST continue to apply when an organization is named, so a single member cannot exhaust an organization's allowance.

An organization dimension that no caller ever populates does not satisfy this requirement. The subject a guard passes MUST be the subject the service enforces.

Period boundaries MUST be UTC calendar day for daily limits and UTC ISO week for weekly limits, so reset times are deterministic and communicable to clients.

A consume that is rejected MUST leave every counter as it was. Partial application is not acceptable: incrementing the counters that passed before discovering that a later one is exhausted charges the caller for work that never happened, and repeated attempts against one exhausted ceiling would then drain the others.

#### Scenario: Consume within daily and weekly ceilings

- **WHEN** an authenticated user successfully consumes a unit of a declared feature and both daily and weekly counts remain below configured ceilings
- **THEN** both counters increment and the consume operation succeeds

#### Scenario: Daily ceiling reached

- **WHEN** a user's daily counter for a feature has reached its configured ceiling
- **THEN** a further consume for that feature is rejected without incrementing past the ceiling

#### Scenario: Weekly ceiling reached while daily remains

- **WHEN** a user's weekly counter for a feature has reached its ceiling but the daily counter has not
- **THEN** a further consume is rejected for the weekly limit

#### Scenario: A rejected consume leaves the daily counter untouched

- **WHEN** a consume is rejected because the weekly ceiling is exhausted while the daily ceiling has room
- **THEN** the daily counter is unchanged, so the caller's daily allowance is not spent on a request that was denied

#### Scenario: A rejected consume leaves the user counter untouched

- **WHEN** a consume for a subject with both user and organization counters is rejected because the organization ceiling is exhausted
- **THEN** the user-scoped counter is unchanged

#### Scenario: Organization subject enforced

- **WHEN** a consume is invoked for a subject naming both an acting member and an organization
- **THEN** both the user-scoped and organization-scoped counters for that feature and period are enforced, and exceeding either rejects the consume

#### Scenario: Member ceiling still applies under an organization

- **WHEN** an acting member has exhausted their own ceiling while the organization they are bound to has allowance remaining
- **THEN** the consume is rejected, so one member cannot spend the organization's whole allowance

#### Scenario: Organization omitted

- **WHEN** a consume is invoked for a subject naming only an acting member
- **THEN** only user-scoped counters are read and written

### Requirement: Feature catalogue and configured ceilings

Feature identifiers used in usage keys MUST come from a code-declared catalogue so callers cannot invent arbitrary unbounded feature strings at runtime without an explicit extension point.

Each feature MUST have configurable daily and weekly ceilings. When the caller has an effective plan with a persisted usage-limit matrix row for that feature, those matrix values MUST be used. Otherwise ceilings MUST come from validated application configuration, with documented defaults suitable for the starter.

An organization-scoped counter SHALL be measured against the organization's own effective plan, not against the ceiling of whichever member happened to make the request. Comparing an organization's aggregate count to one member's allowance means the organization limit is effectively a single member's limit, and no org-wide ceiling can be expressed however the matrices are configured.

#### Scenario: Unknown feature rejected

- **WHEN** application code attempts to consume a feature identifier outside the catalogue
- **THEN** the operation fails as a programming/configuration error rather than silently creating an unbounded counter namespace

#### Scenario: Ceiling from plan matrix

- **WHEN** an entitled user's effective plan defines a daily ceiling for a feature and the user reaches that count
- **THEN** further consumes for that feature that day are rejected at the plan matrix ceiling

#### Scenario: Ceiling from configuration fallback

- **WHEN** no plan matrix row applies for the caller's effective plan and feature, and a feature's daily ceiling is set via configuration
- **THEN** further consumes for that feature that day are rejected at the configured ceiling

#### Scenario: Organization ceiling comes from the organization's plan

- **WHEN** an organization on a higher plan than the calling member consumes a feature whose matrix values differ between the two plans
- **THEN** the organization-scoped counter is measured against the organization's ceiling, so a member on a lower plan does not cap the organization

### Requirement: Plan-aware ceiling resolution uses the resolved principal

Usage ceiling resolution for an authenticated consume MUST derive the effective plan from the same subscription/plan rules as the entitlements gate, using the already-resolved billing subject, without performing a separate session lookup.

The effective plan SHALL be resolved at most once per subject per consume. Plan resolution reads persisted subscriptions, so resolving it again for each period and again for each counter turns one metered request into several identical database queries — the same reason effective permissions are resolved once per request rather than per requirement check.

Ceiling resolution SHALL sit inside the fail-closed boundary. A failure to resolve a ceiling MUST be reported as the same temporary-service condition as a counter-store failure, not as an unexpected internal error, because the caller's remedy is identical and the distinction is invisible to them.

#### Scenario: Pro user gets Pro ceilings

- **WHEN** a user with an entitled Pro subscription consumes a catalogue feature that has distinct Lite and Pro matrix values
- **THEN** the Pro daily and weekly ceilings are applied

#### Scenario: Lite fallback ceilings

- **WHEN** a user with no entitled subscription consumes a catalogue feature
- **THEN** the Lite plan's matrix ceilings apply when present, otherwise configuration defaults

#### Scenario: Plan resolved once per consume

- **WHEN** a single consume evaluates both the daily and weekly periods for one subject
- **THEN** the effective plan for that subject is resolved once, not once per period and again per counter

#### Scenario: Ceiling resolution failure fails closed as a service condition

- **WHEN** the persisted subscriptions cannot be read while resolving a ceiling
- **THEN** the consume is rejected with the same temporary-service status as a counter-store failure, and not as an internal error

### Requirement: Guard-chain and programmatic consume

Usage enforcement SHALL be available both as an optional route annotation for simple metered endpoints and as a programmatic service API for feature modules that must meter only successful billable work.

Usage checks that run as guards MUST execute after authentication, authorization, and request throttling, and MUST consume the already-resolved principal rather than re-resolving the session.

A guard SHALL resolve the organization dimension the same way the credit gate resolves its billing subject, so a request bound to an organization is metered against that organization alongside the acting member. Passing a member-only subject from the guard while the service accepts an organization dimension leaves that dimension unreachable in practice, however carefully the key scheme provides for it.

#### Scenario: Annotated route enforces usage

- **WHEN** a route is annotated for a catalogue feature and the caller's daily ceiling for that feature is exhausted
- **THEN** the response is `429` with `USAGE_LIMIT_EXCEEDED` and the handler does not execute

#### Scenario: Programmatic consume after success path

- **WHEN** a service successfully completes a billable unit and calls consume for that feature
- **THEN** the matching daily and weekly counters increment by one

#### Scenario: Principal not re-resolved

- **WHEN** a usage guard runs for an authenticated request
- **THEN** it reads the principal established by authentication and does not perform a separate session lookup

#### Scenario: Guard meters an organization-bound request

- **WHEN** a request binds an organization the caller belongs to and calls a usage-annotated route
- **THEN** the organization-scoped counter for that feature is enforced alongside the user-scoped one
