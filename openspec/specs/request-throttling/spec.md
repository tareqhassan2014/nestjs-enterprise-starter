# Request Throttling

## Purpose

Redis-backed Nest request admission control: named burst and per-minute windows applied to application routes, with per-route policy overrides and clear fail-closed behaviour when the counter store is unavailable.

## Requirements

### Requirement: Global Redis-backed Nest throttling with burst and per-minute windows

Every Nest-handled route SHALL be subject to two named Redis-backed rate limits by default: a short **burst** window and a longer **per-minute** window. Both MUST be satisfied for the request to proceed.

Limits and window lengths MUST come from validated application configuration. Counters MUST live in the shared Redis client so limits hold across application instances.

#### Scenario: Within both limits

- **WHEN** an authenticated or anonymous client calls a Nest route without exceeding burst or per-minute ceilings
- **THEN** the handler executes normally

#### Scenario: Burst exceeded

- **WHEN** a client exceeds the burst limit within its window
- **THEN** the response is `429` with error code `RATE_LIMITED` and the handler does not execute

#### Scenario: Per-minute exceeded while under burst

- **WHEN** a client stays under the burst ceiling but exceeds the per-minute ceiling
- **THEN** the response is `429` with error code `RATE_LIMITED`

#### Scenario: Limits shared across instances

- **WHEN** two application instances share Redis and a client splits requests across both until the combined count exceeds a limit
- **THEN** further requests are rejected with `429` regardless of which instance receives them

### Requirement: Per-route throttle policies

The system SHALL support declarative per-route and per-controller overrides of the default burst and per-minute ceilings, including a stricter policy for first-party account and session management routes under the versioned API, and a skip policy for health probes.

The mounted authentication library surface at `/api/auth/*` MUST remain outside Nest throttling; its own Redis-backed limiter remains authoritative there.

#### Scenario: Strict policy on account routes

- **WHEN** a client exceeds the strict policy ceiling on a first-party account management route but would still be under the default global ceiling
- **THEN** the response is `429` with error code `RATE_LIMITED`

#### Scenario: Default policy on a public Nest route

- **WHEN** a client calls a public Nest route that uses the default policy
- **THEN** the default burst and per-minute ceilings apply, not the strict account ceilings

#### Scenario: Health probes are not throttled

- **WHEN** a client calls `/health/live` or `/health/ready` repeatedly beyond the default ceilings
- **THEN** the probes still return their normal health responses and are not rejected as rate-limited by Nest throttling

#### Scenario: Auth library surface unaffected by Nest throttler

- **WHEN** Nest throttling is exhausted for a client on `/api/v1` routes
- **THEN** `/api/auth/*` continues to enforce only the authentication library's own rate limits, not the Nest throttler counters

### Requirement: Throttle tracking identity

Throttle counters SHALL key on the authenticated user when a principal is present, and on the client IP address otherwise.

IP identity MUST honour the same proxy-trust configuration used elsewhere in the application, so a client cannot forge forwarded-address headers to bypass limits when proxy trust is disabled.

#### Scenario: Authenticated requests share a per-user counter

- **WHEN** an authenticated user sends requests from two different IP addresses
- **THEN** both consume the same per-user throttle counters

#### Scenario: Anonymous requests key by IP

- **WHEN** an unauthenticated client exceeds the limit from one IP
- **THEN** a different IP under the same default policy is not blocked by that counter

#### Scenario: Forged forwarded header without trust

- **WHEN** proxy trust is disabled and a client sends a forged forwarded-address header while exceeding the limit
- **THEN** the request is still rate-limited under the real connection address

### Requirement: Throttle rejection timing headers

A Nest throttle rejection SHALL include a `Retry-After` header indicating whole seconds until the client may retry, and SHALL use the standard error envelope with code `RATE_LIMITED` on enveloped routes.

#### Scenario: Retry-After on throttle 429

- **WHEN** a Nest route rejects a request for exceeding a throttle window
- **THEN** the response includes `Retry-After` with a positive integer number of seconds
- **AND** the body carries `success: false` and `error.code` `RATE_LIMITED`

### Requirement: Throttle storage failure fails closed

When Redis is unavailable for a Nest throttle check, the request MUST be rejected rather than admitted unmetered. The failure MUST be distinguishable from a genuine rate-limit exceedance.

#### Scenario: Redis down during Nest throttle check

- **WHEN** Redis cannot serve a throttle counter read or write for a Nest route
- **THEN** the response is `503` with error code `SERVICE_UNAVAILABLE`
- **AND** the response is not a `429` with `RATE_LIMITED`

### Requirement: Reuse of the shared Redis connection

Nest throttling MUST use the application's existing shared Redis client and MUST NOT open a separate Redis connection solely for rate-limit storage.

#### Scenario: Single client for throttle storage

- **WHEN** the throttling module is inspected at runtime
- **THEN** its storage adapter uses the same Redis client provider as session cache and health checks

### Requirement: MCP transport and tool invocations are throttled

MCP HTTP traffic and/or per-tool invocations SHALL be subject to Redis-backed burst and per-minute throttling using the shared Redis client. Ceilings MUST come from validated configuration (global defaults and/or MCP-specific overrides).

When a ceiling is exceeded, the tool adapter MUST NOT run and the client MUST receive a rate-limit denial in MCP error form (HTTP `429` on the transport is acceptable where the transport surfaces it).

The MCP path MUST NOT be entirely exempt from throttling while enabled, except for explicitly documented health-style probes unrelated to tool execution.

#### Scenario: Within MCP limits

- **WHEN** an authenticated agent invokes tools under the configured MCP burst and per-minute ceilings
- **THEN** permitted tools proceed past the throttle stage

#### Scenario: MCP burst exceeded

- **WHEN** an agent exceeds the MCP burst ceiling within its window
- **THEN** further tool invocations are denied as rate limited and adapters do not run

#### Scenario: Limits shared across instances

- **WHEN** two application instances share Redis and an agent splits MCP calls across both until the combined count exceeds a limit
- **THEN** further invocations are rate-limited regardless of which instance receives them
