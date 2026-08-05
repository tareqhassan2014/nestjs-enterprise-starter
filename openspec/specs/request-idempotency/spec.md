# Request Idempotency

## Purpose

Opt-in `Idempotency-Key` support for critical POST routes: a client-supplied key plus a request fingerprint identify a logical operation, so a retried request replays the original stored outcome instead of double-charging, double-enqueuing, or double-mutating. Concurrent duplicates are serialized so only one execution ever applies side effects, and records expire so storage does not grow without bound.

## Requirements

### Requirement: Opt-in Idempotency-Key for critical POSTs

The system SHALL support an opt-in idempotency mechanism for annotated POST routes. When a route is annotated for idempotency, the client MUST supply an `Idempotency-Key` header (opaque string within validated length bounds). Missing keys on annotated routes MUST be rejected with a distinct envelope error code.

#### Scenario: Missing key on annotated route

- **WHEN** a client POSTs to an idempotency-annotated route without `Idempotency-Key`
- **THEN** the response is `400` with error code `IDEMPOTENCY_KEY_REQUIRED` and the handler does not run

#### Scenario: First request with new key executes once

- **WHEN** an authenticated client POSTs with a new idempotency key and a valid body
- **THEN** the handler runs once and the success (or stored error) response is persisted for replay

### Requirement: Replay returns the original response

Replaying the same principal, route, and idempotency key with the same request fingerprint MUST return the stored status and body without re-executing the handler's side effects.

#### Scenario: Client retries after timeout

- **WHEN** the same user retries a completed idempotent POST with the same key and body
- **THEN** the stored response is returned and domain side effects (ledger writes, enqueues, org creates) are not applied a second time

### Requirement: Key reuse with different payload conflicts

Reusing an idempotency key for the same principal and route with a different request fingerprint SHALL be rejected with `409` and error code `IDEMPOTENCY_KEY_REUSE`.

#### Scenario: Same key different body

- **WHEN** a client reuses an idempotency key with a modified JSON body
- **THEN** the response is `409` with `IDEMPOTENCY_KEY_REUSE` and the original stored outcome remains unchanged

### Requirement: In-flight duplicates do not double-apply

While a first request with a given key is still processing, a concurrent duplicate MUST NOT run the handler concurrently in a way that double-applies side effects. The system MUST use a uniqueness/locking strategy so only one execution proceeds.

#### Scenario: Parallel duplicate requests

- **WHEN** two identical idempotent POSTs arrive concurrently with the same key and body
- **THEN** only one handler execution applies side effects and both clients eventually observe a single logical outcome

### Requirement: Idempotency records expire

Stored idempotency records MUST carry an expiry derived from validated configuration and MUST become ineligible for replay after expiry so storage does not grow without bound.

#### Scenario: Expired key may be reused as new

- **WHEN** an idempotency record's expiry has passed and a client submits that key again
- **THEN** the request is treated as a new execution rather than a replay of the expired record
