## MODIFIED Requirements

### Requirement: Authenticate then authorize, in a fixed and extensible order

Access control SHALL run as an ordered chain: authentication resolves the principal, then authorization evaluates the route's declared requirements.

Authorization MUST NOT re-resolve the session; it consumes the principal established by authentication. The chain's ordering SHALL be: authentication, authorization, plan entitlements (when present), request throttling, usage limits, then credit checks — extending in that order rather than introducing a parallel mechanism.

Request throttling and usage-limit stages MUST consume the already-resolved principal when keying per-user counters, and MUST NOT perform their own session lookup.

#### Scenario: Unauthenticated request to a permission-gated route

- **WHEN** a request with no session calls a route requiring a permission
- **THEN** the response is `401`, and no permission lookup is performed

#### Scenario: Authenticated but unpermitted

- **WHEN** an authenticated user without the required permission calls the route
- **THEN** the response is `403` with error code `FORBIDDEN` and the handler never executes

#### Scenario: Authenticated and permitted

- **WHEN** an authenticated user holding the required permission calls the route
- **THEN** the handler executes

#### Scenario: Session resolved once

- **WHEN** a request passes through the full chain
- **THEN** the session is resolved a single time and later stages read the already-resolved principal

#### Scenario: Throttling runs after authorization

- **WHEN** an authenticated but unpermitted user calls a permission-gated route that would also be over a throttle ceiling
- **THEN** the response is `403` and throttle counters for that request are not required to increment as a successful admission

#### Scenario: Usage limits run after throttling

- **WHEN** the guard registration order is inspected
- **THEN** request throttling is registered after authorization and before usage-limit enforcement, and both appear before any credit check
