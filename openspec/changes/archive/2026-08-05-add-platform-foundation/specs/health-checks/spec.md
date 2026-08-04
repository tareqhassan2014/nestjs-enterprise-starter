## ADDED Requirements

### Requirement: Liveness endpoint

The application SHALL expose `GET /health/live`, returning `200` whenever the process is running and able to serve HTTP.

Liveness MUST NOT check any external dependency. A dependency outage MUST NOT cause the liveness probe to fail, because doing so converts a dependency outage into a restart loop.

#### Scenario: Process healthy

- **WHEN** the liveness endpoint is called on a running application
- **THEN** the response is `200`

#### Scenario: Database unreachable

- **WHEN** PostgreSQL is unreachable and the liveness endpoint is called
- **THEN** the response is still `200`

#### Scenario: Redis unreachable

- **WHEN** Redis is unreachable and the liveness endpoint is called
- **THEN** the response is still `200`

### Requirement: Readiness endpoint gated on dependencies

The application SHALL expose `GET /health/ready`, returning `200` only when PostgreSQL and Redis are both reachable, and `503` otherwise.

The response body MUST identify per-dependency status so an operator can tell which dependency is failing. Each dependency check MUST apply a timeout so a hung dependency does not hang the probe.

#### Scenario: All dependencies reachable

- **WHEN** PostgreSQL and Redis both respond and the readiness endpoint is called
- **THEN** the response is `200` and reports both dependencies as up

#### Scenario: Database unreachable

- **WHEN** PostgreSQL is unreachable and the readiness endpoint is called
- **THEN** the response is `503` and identifies the database check as the failing one

#### Scenario: Redis unreachable

- **WHEN** Redis is unreachable and the readiness endpoint is called
- **THEN** the response is `503` and identifies the Redis check as the failing one

#### Scenario: Dependency hangs

- **WHEN** a dependency accepts the connection but never responds
- **THEN** the check fails on timeout and the endpoint responds `503` rather than hanging

### Requirement: Health responses bypass the API envelope

Health endpoints SHALL return their health payload directly, without the success envelope, so orchestrator probes receive the shape they expect.

#### Scenario: Liveness response shape

- **WHEN** the liveness endpoint returns successfully
- **THEN** the body contains the health payload with no `success`, `data`, or `meta` wrapper

#### Scenario: Readiness failure response shape

- **WHEN** readiness fails because a dependency is down
- **THEN** the `503` body is the health payload identifying the failing dependency, not the generic error envelope

### Requirement: Graceful shutdown

The application SHALL enable shutdown hooks so that on `SIGTERM` it stops accepting new connections, allows in-flight requests to complete, and closes database and Redis connections before the process exits.

#### Scenario: SIGTERM received

- **WHEN** the process receives `SIGTERM`
- **THEN** database and Redis connections are closed and the process exits with code `0`

#### Scenario: Request in flight during shutdown

- **WHEN** `SIGTERM` arrives while a request is being handled
- **THEN** that request completes and its response is sent before the process exits
