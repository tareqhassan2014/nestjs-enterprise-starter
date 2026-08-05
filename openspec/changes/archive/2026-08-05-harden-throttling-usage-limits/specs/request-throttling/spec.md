## MODIFIED Requirements

### Requirement: Per-route throttle policies

The system SHALL support declarative per-route and per-controller overrides of the default burst and per-minute ceilings, including a stricter policy for first-party account and session management routes under the versioned API, and a skip policy for health probes.

The mounted authentication library surface at `/api/auth/*` MUST remain outside Nest throttling; its own Redis-backed limiter remains authoritative there.

Each policy SHALL be enforced against its own counter. A ceiling declared for one policy MUST NOT be consumed by traffic governed by another, because comparing a shared count against a smaller ceiling makes the stricter policy trip on unrelated traffic — a caller who has made no account-route request at all can arrive at one already over its limit.

A block or penalty written when one policy is exceeded MUST apply only to routes governed by that policy. A policy-agnostic block turns a stricter ceiling on a narrow surface into a denial of the whole API, which inverts the intent of declaring it: the tighter limit exists to protect a sensitive surface, not to make that surface a lever for locking the caller out of everything else.

#### Scenario: Strict policy on account routes

- **WHEN** a client exceeds the strict policy ceiling on a first-party account management route but would still be under the default global ceiling
- **THEN** the response is `429` with error code `RATE_LIMITED`

#### Scenario: Default policy on a public Nest route

- **WHEN** a client calls a public Nest route that uses the default policy
- **THEN** the default burst and per-minute ceilings apply, not the strict account ceilings

#### Scenario: Default traffic does not consume the strict allowance

- **WHEN** a client makes enough default-policy requests to exceed the strict ceiling but stay under the default ceiling, then calls a strict-policy route for the first time
- **THEN** that first strict-policy request is admitted, because the strict ceiling is counted separately

#### Scenario: A strict block does not deny default routes

- **WHEN** a client is blocked for exceeding the strict ceiling on an account route
- **THEN** requests to default-policy routes are still evaluated against the default ceiling and are admitted while under it

#### Scenario: Health probes are not throttled

- **WHEN** a client calls `/health/live` or `/health/ready` repeatedly beyond the default ceilings
- **THEN** the probes still return their normal health responses and are not rejected as rate-limited by Nest throttling

#### Scenario: Auth library surface unaffected by Nest throttler

- **WHEN** Nest throttling is exhausted for a client on `/api/v1` routes
- **THEN** `/api/auth/*` continues to enforce only the authentication library's own rate limits, not the Nest throttler counters

### Requirement: Throttle storage failure fails closed

When Redis is unavailable for a Nest throttle check, the request MUST be rejected rather than admitted unmetered. The failure MUST be distinguishable from a genuine rate-limit exceedance.

Distinguishability SHALL hold on every throttled surface, including MCP tool invocations, and MUST NOT depend on whether the surface happens to carry the HTTP error envelope. A denial that reports "rate limited" when the cause is an unreachable counter store tells the caller to wait for a window that will never elapse, and hides an outage behind a routine, self-clearing condition — so the two MUST NOT share a reason code even where the transport shape is the same.

#### Scenario: Redis down during Nest throttle check

- **WHEN** Redis cannot serve a throttle counter read or write for a Nest route
- **THEN** the response is `503` with error code `SERVICE_UNAVAILABLE`
- **AND** the response is not a `429` with `RATE_LIMITED`

#### Scenario: Redis down during an MCP throttle check

- **WHEN** Redis cannot serve a throttle counter operation for an MCP tool invocation
- **THEN** the invocation is denied and the adapter does not run
- **AND** the denial reason names a temporary service condition rather than a rate-limit exceedance

#### Scenario: A genuine MCP exceedance stays a rate limit

- **WHEN** an agent exceeds a configured MCP ceiling while Redis is healthy
- **THEN** the denial reports a rate-limit exceedance, distinct from the storage-failure reason
