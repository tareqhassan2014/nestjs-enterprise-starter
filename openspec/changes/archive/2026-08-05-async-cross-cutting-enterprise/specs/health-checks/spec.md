## MODIFIED Requirements

### Requirement: Graceful shutdown

The application SHALL enable shutdown hooks so that on `SIGTERM` it stops accepting new connections, allows in-flight HTTP requests to complete, pauses queue workers and waits for active jobs up to a configured drain timeout, then closes database, Redis, BullMQ, and storage clients before the process exits.

Readiness MUST fail (or stop reporting ready) once shutdown has begun so orchestrators stop sending traffic.

#### Scenario: SIGTERM received

- **WHEN** the process receives `SIGTERM`
- **THEN** database, Redis, queue workers, and storage clients are closed and the process exits with code `0`

#### Scenario: Request in flight during shutdown

- **WHEN** `SIGTERM` arrives while a request is being handled
- **THEN** that request completes and its response is sent before the process exits

#### Scenario: Active queue job during shutdown

- **WHEN** `SIGTERM` arrives while a BullMQ job is actively processing and the drain timeout has not elapsed
- **THEN** the worker waits for that job to finish (or until the drain timeout) before forcing close
