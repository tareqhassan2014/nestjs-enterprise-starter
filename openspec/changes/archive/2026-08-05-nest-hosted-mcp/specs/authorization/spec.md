## ADDED Requirements

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

## MODIFIED Requirements

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
