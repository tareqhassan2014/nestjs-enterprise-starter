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

Access control SHALL run as an ordered chain: authentication resolves the principal, then authorization evaluates the route's or tool's declared requirements, then plan entitlements evaluate commercial gates when annotated.

Authentication MAY establish the principal from a Better Auth session (Nest HTTP) or from a valid agent API key (MCP and any other opted-in surfaces). Authorization MUST NOT re-resolve the session or API key; it consumes the principal established by authentication. The chain's ordering SHALL be: authentication, authorization, plan entitlements, request throttling, usage limits, then credit checks — extending in that order rather than introducing a parallel mechanism.

Plan entitlement, request throttling, usage-limit, and credit-check stages MUST consume the already-resolved principal, and MUST NOT perform their own session or API-key lookup.

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

- **WHEN** a request passes through the full Nest HTTP chain
- **THEN** the session is resolved a single time and later stages read the already-resolved principal

#### Scenario: Entitlements run after authorization

- **WHEN** the guard registration order is inspected
- **THEN** plan entitlements are registered after authorization and before request throttling

#### Scenario: Throttling runs after entitlements

- **WHEN** an authenticated and RBAC-permitted user lacks a required entitlement on a route that would also be over a throttle ceiling
- **THEN** the response is `403` with a plan entitlement error code and throttle counters for that request are not required to increment as a successful admission

#### Scenario: Usage limits run after throttling

- **WHEN** the guard registration order is inspected
- **THEN** request throttling is registered after plan entitlements and before usage-limit enforcement, and both appear before credit checks

#### Scenario: Credit checks run after usage limits

- **WHEN** the guard registration order is inspected
- **THEN** credit checks are registered after usage-limit enforcement

#### Scenario: API-key principal participates in the same order on MCP

- **WHEN** an MCP tool invocation authenticates via API key and declares RBAC and credit requirements
- **THEN** authorization runs before credit spend, and stages read the API-key-resolved principal without a session lookup

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

The invalidation path MUST be reachable from every process that mutates access-control data, including one that is not the running application — the seed and any operator tooling mutate the same tables and MUST be able to advance the marker without a running instance. An invalidation mechanism callable only from inside the application process, or only from a test, does not satisfy this requirement: it makes the guarantee an artefact of the test harness rather than a property of the system.

Where a mutation is applied without advancing the marker, the resulting staleness SHALL be bounded by the cache entry lifetime, and that bound SHALL be documented as the worst case rather than left implied. A caller MUST NOT have to infer it from a constant in the source.

#### Scenario: Repeated checks within one request

- **WHEN** a single request evaluates two permission requirements
- **THEN** the effective permission set is resolved once for that request

#### Scenario: Mapping change is observed

- **WHEN** a role's permission mapping changes and a user holding that role makes a request
- **THEN** the request is evaluated against the new mapping

#### Scenario: Revocation is observed

- **WHEN** a role is removed from a user
- **THEN** their next request no longer carries that role's permissions

#### Scenario: Seed advances the marker

- **WHEN** the seed runs against a migrated database while an application instance is serving traffic
- **THEN** the marker is advanced, and a user whose grants the seed changed is evaluated against the new mapping on their next request

#### Scenario: Invalidation is reachable outside the application process

- **WHEN** the invalidation path is inspected
- **THEN** it can be invoked by a process that is not the running application, without depending on the application's dependency injection container

#### Scenario: Staleness bound is stated

- **WHEN** a mutation is applied without advancing the marker
- **THEN** the delay before it is observed is no longer than the documented cache entry lifetime

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

### Requirement: Admin monitoring permissions in the vocabulary

The permission vocabulary SHALL include operational admin identifiers for metrics reads, audit reads, cross-user subscription reads, cross-user credit reads, and credit adjustments.

At minimum the set MUST include `admin:metrics:read`, `admin:audit:read`, `admin:subscriptions:read`, `admin:credits:read`, and `admin:credits:adjust`. The baseline `admin` role MUST receive every declared permission, including these. The baseline `user` role MUST NOT receive them.

#### Scenario: Catalogue includes admin monitoring permissions

- **WHEN** the code-declared permission catalogue is inspected
- **THEN** it contains `admin:metrics:read`, `admin:audit:read`, `admin:subscriptions:read`, `admin:credits:read`, and `admin:credits:adjust`

#### Scenario: Seed grants admin all permissions

- **WHEN** the seed runs against a migrated database
- **THEN** the `admin` role mapping includes every declared permission identifier

#### Scenario: User role lacks admin monitoring permissions

- **WHEN** the seeded `user` role permissions are inspected
- **THEN** they do not include `admin:metrics:read`, `admin:audit:read`, `admin:subscriptions:read`, `admin:credits:read`, or `admin:credits:adjust`

### Requirement: API key management and MCP tool permissions

The permission vocabulary SHALL include identifiers for managing one’s own API keys and for invoking MCP tools that require explicit grants beyond “authenticated user”.

At minimum the set MUST include a self-management permission for API keys (for example `api-keys:manage`). Read-oriented starter tools MAY rely on existing account/plan/credits/usage permissions already held by the baseline `user` role, or on a small set of `mcp:*` permissions seeded onto `user` — either approach MUST be documented in the catalogue.

The baseline `admin` role MUST receive every declared permission. Forks MUST be able to revoke MCP-related permissions from `user` without code changes beyond seed/mappings.

#### Scenario: Catalogue includes API key management permission

- **WHEN** the code-declared permission catalogue is inspected
- **THEN** it contains a permission used to create, list, and revoke the caller’s own API keys

#### Scenario: Seeded user can manage own keys

- **WHEN** the seed runs and a baseline `user` calls the key-management routes with a valid session
- **THEN** create/list/revoke of that user’s keys are permitted

### Requirement: MCP tool calls use the same ordered commercial pipeline

MCP tool invocations that are subject to commercial gates SHALL evaluate stages in this order after authentication: authorization (RBAC), plan entitlements, request throttling, usage limits, then credit checks.

Stages MUST consume the principal resolved from the API key and MUST NOT perform a separate session lookup. This pipeline is the MCP counterpart to the Nest HTTP guard chain and MUST NOT introduce a parallel authorization mechanism with different semantics.

#### Scenario: Order matches HTTP chain semantics

- **WHEN** a tool declares permission, plan, usage, and credit requirements
- **THEN** a caller failing RBAC is denied before usage or credits are consumed, and a caller failing usage limits is denied before credits are spent

#### Scenario: Principal resolved once per invocation

- **WHEN** a tool invocation passes through the full MCP pipeline
- **THEN** the API key is verified a single time for that invocation and later stages read the already-resolved principal
