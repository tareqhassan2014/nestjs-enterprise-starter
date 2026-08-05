## ADDED Requirements

### Requirement: Queue-backed dispatch for non-blocking mail

The system SHALL allow application code to enqueue outbound mail through the job-queues `email` queue while still describing messages only via the provider-agnostic mail port (payload fields remain port-shaped). Workers MUST invoke the configured mail adapter; callers MUST NOT import BullMQ outside the queues/mail integration module.

Auth-critical paths that require fail-visible synchronous send MAY continue to call the port directly. Non-critical notifications (including low-balance when wired) MUST enqueue rather than block the request on SMTP.

#### Scenario: Enqueued message is delivered by worker

- **WHEN** a low-balance or other non-critical path enqueues an email job
- **THEN** a worker processes the job by calling the mail port and the originating request is not blocked on SMTP round-trip

#### Scenario: Sync auth path still uses the port

- **WHEN** registration verification mail is sent on the synchronous path
- **THEN** it still goes through the mail port and failures surface to the caller per existing delivery-failure requirements
