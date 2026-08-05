## ADDED Requirements

### Requirement: Feature flag vocabulary is declared in code

The system SHALL declare feature flag identifiers in code as the vocabulary for evaluation. Typed evaluation APIs MUST only accept identifiers from that declaration so unknown keys are compile-time errors.

#### Scenario: Known flag evaluates

- **WHEN** application code evaluates a declared flag through the feature-flags service
- **THEN** the service returns a boolean (or declared typed value) without requiring a stringly-typed key

#### Scenario: Undeclared flag is not type-legal

- **WHEN** code attempts to evaluate a flag identifier absent from the declaration
- **THEN** the type check fails and the project does not build

### Requirement: Evaluation order is override, then env default, then code default

Flag evaluation SHALL resolve in this order: optional persisted override for the evaluation context, then environment/config default, then the code-declared default. A kill-switch override MUST win over env and code defaults.

#### Scenario: Persisted override wins

- **WHEN** a flag has code default `false`, env default `false`, and a persisted override `true` for the global scope
- **THEN** evaluation returns `true`

#### Scenario: Env default when no override

- **WHEN** no persisted override exists and env sets the flag default to `true`
- **THEN** evaluation returns `true` even if the code default is `false`

### Requirement: Optional context for user or organization overrides

The evaluation API SHALL accept optional context including user id and organization id. When a more specific override exists for that subject, it MUST take precedence over a global override according to documented specificity (organization or user more specific than global).

#### Scenario: Org override applies in org context

- **WHEN** an organization-scoped override enables a flag and evaluation is invoked with that organization id
- **THEN** the flag evaluates to the override value for that call

### Requirement: Flags do not bypass auth or commercial gates

Feature flags MUST NOT replace authentication, RBAC, entitlements, throttle, usage, or credits checks. A flag may hide or enable a surface, but an enabled flag MUST still pass the guard chain for protected routes.

#### Scenario: Flag on still requires auth

- **WHEN** a flag enables an experimental route and an unauthenticated client calls it
- **THEN** the response is still `401` / `UNAUTHORIZED` (or the route's declared auth failure)
