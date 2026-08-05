# Authorization

## Purpose

What the caller may do: routes closed by default, a permission vocabulary declared in code, and roles and mappings persisted so access can change without a deployment.

Protection is applied globally, so a route added tomorrow is protected before anyone considers protecting it, and opening one is an explicit, greppable act. The vocabulary lives in code so a misspelled identifier fails the build rather than silently granting nothing; the assignments live in the database so an operator can change them at runtime.

## Requirements

### Requirement: Routes are protected unless explicitly made public

Every application route SHALL require an authenticated session by default. A route SHALL become reachable without authentication only by carrying an explicit public marker.

Protection MUST be applied globally rather than per controller, so a newly added route is protected before anyone considers protecting it. The marker MUST be a single, greppable declaration so the full set of open routes can be audited.

#### Scenario: New route added with no annotations

- **WHEN** a controller route is added with no authentication or permission annotations and is called without a session
- **THEN** the response is `401` with error code `UNAUTHORIZED` and the handler never executes

#### Scenario: Route marked public

- **WHEN** a route carrying the public marker is called without a session
- **THEN** the handler executes normally

#### Scenario: Health probes remain reachable

- **WHEN** an orchestrator polls `/health/live` and `/health/ready` with no credentials
- **THEN** both respond as specified by the health capability and neither returns `401`

#### Scenario: Auditing open routes

- **WHEN** the codebase is searched for the public marker
- **THEN** every route reachable without authentication is found, with no other mechanism able to open a route

### Requirement: Roles and permissions are persisted and editable at runtime

The system SHALL persist roles, permissions, the mapping between them, and the assignment of roles to users. A user SHALL be able to hold more than one role.

Role assignments and role-to-permission mappings MUST be changeable without deploying code. The mapping table MUST enforce uniqueness in the database so repeated seeding cannot duplicate rows.

#### Scenario: Role granted at runtime

- **WHEN** a role is assigned to a user in the database and the user makes a subsequent request
- **THEN** the permissions of that role are in effect for the request

#### Scenario: Mapping changed at runtime

- **WHEN** a permission is added to a role's mapping
- **THEN** users holding that role gain the permission without a deployment

#### Scenario: Multiple roles

- **WHEN** a user holds two roles
- **THEN** their effective permissions are the union of both roles' permissions

#### Scenario: Duplicate mapping rejected

- **WHEN** the same role-to-permission pair is inserted twice
- **THEN** the database rejects the duplicate

### Requirement: The permission vocabulary is declared in code

The set of permission identifiers SHALL be declared in code as the single source of the vocabulary, and route annotations SHALL be typed against it so an unknown identifier is a compile-time error.

The persisted permission catalogue SHALL be seeded from that declaration. A permission row present in the database but absent from the declaration MUST have no effect on any decision.

#### Scenario: Misspelled permission in an annotation

- **WHEN** a route annotation names a permission identifier that is not in the declared set
- **THEN** the type check fails and the project does not build

#### Scenario: Catalogue seeded from code

- **WHEN** the seed runs against a migrated database
- **THEN** the persisted catalogue contains exactly the declared permission identifiers

#### Scenario: Orphan permission row

- **WHEN** a permission row that no declaration names is granted to a role
- **THEN** no authorization decision changes, because no annotation can reference it

#### Scenario: Permission added to the declaration

- **WHEN** a new permission identifier is added in code and the seed is re-run
- **THEN** the catalogue gains that identifier and no existing rows are duplicated

### Requirement: Authenticate then authorize, in a fixed and extensible order

Access control SHALL run as an ordered chain: authentication resolves the principal, then authorization evaluates the route's declared requirements, then plan entitlements evaluate commercial gates when annotated.

Authorization MUST NOT re-resolve the session; it consumes the principal established by authentication. The chain's ordering SHALL be: authentication, authorization, plan entitlements, request throttling, usage limits, then credit checks — extending in that order rather than introducing a parallel mechanism.

Plan entitlement, request throttling, and usage-limit stages MUST consume the already-resolved principal, and MUST NOT perform their own session lookup.

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

#### Scenario: Entitlements run after authorization

- **WHEN** the guard registration order is inspected
- **THEN** plan entitlements are registered after authorization and before request throttling

#### Scenario: Throttling runs after entitlements

- **WHEN** an authenticated and RBAC-permitted user lacks a required entitlement on a route that would also be over a throttle ceiling
- **THEN** the response is `403` with a plan entitlement error code and throttle counters for that request are not required to increment as a successful admission

#### Scenario: Usage limits run after throttling

- **WHEN** the guard registration order is inspected
- **THEN** request throttling is registered after plan entitlements and before usage-limit enforcement, and both appear before any credit check

### Requirement: Route requirements are declared by annotation

The system SHALL provide annotations to require one or more permissions, to require one or more roles, and to inject the current principal into a handler.

When several permissions are required, all MUST be satisfied. When several roles are accepted, any one MUST suffice. Annotations at method level SHALL take precedence over the same annotation at controller level.

#### Scenario: Multiple permissions required

- **WHEN** a route requires two permissions and the user holds only one
- **THEN** the response is `403`

#### Scenario: Any of several roles accepted

- **WHEN** a route accepts either of two roles and the user holds one of them
- **THEN** the handler executes

#### Scenario: Controller-level requirement inherited

- **WHEN** a requirement is declared on the controller and a method declares none
- **THEN** the controller's requirement applies to that method

#### Scenario: Method-level requirement overrides

- **WHEN** a method declares a requirement different from its controller's
- **THEN** the method's requirement is the one enforced

#### Scenario: Principal injected

- **WHEN** a handler declares a parameter annotated to receive the current principal
- **THEN** it receives the authenticated user's identity

### Requirement: Effective permissions are cached with versioned invalidation

Effective permission sets SHALL be resolved at most once per request and MAY be cached across requests. Cache invalidation SHALL be performed by advancing a version marker rather than by enumerating or deleting cache keys.

A mutation to any role, mapping, or assignment MUST cause subsequent requests to observe the new state. A cache read failure MUST fall back to the persisted store rather than deny the request.

#### Scenario: Repeated checks within one request

- **WHEN** a single request evaluates two permission requirements
- **THEN** the effective permission set is resolved once for that request

#### Scenario: Mapping change is observed

- **WHEN** a role's permission mapping changes and a user holding that role makes a request
- **THEN** the request is evaluated against the new mapping

#### Scenario: Revocation is observed

- **WHEN** a role is removed from a user
- **THEN** their next request no longer carries that role's permissions

#### Scenario: Cache unavailable

- **WHEN** the permission cache is unreachable and an authenticated user calls a permission-gated route
- **THEN** the decision is made from the persisted store and the request is not denied because of the cache

#### Scenario: Stale entries are unreachable

- **WHEN** the version marker advances
- **THEN** entries written under the previous version are never read again

### Requirement: Authorization failures are auditable and do not leak the policy

A denied request SHALL be logged with the request identifier, the principal, the route, and the requirement that was not met.

The response body MUST NOT enumerate the permissions the caller lacks or the full requirement set, so the error does not describe the policy to an attacker.

#### Scenario: Denial is logged

- **WHEN** an authenticated user is denied for a missing permission
- **THEN** a log entry records the request identifier, the user identifier, the route, and the unmet requirement

#### Scenario: Response does not enumerate policy

- **WHEN** a `403` response is returned for a missing permission
- **THEN** the body carries the `FORBIDDEN` code and a generic message, and does not list required or missing permissions
