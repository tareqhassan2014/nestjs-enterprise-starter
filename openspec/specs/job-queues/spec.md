# Job Queues

## Purpose

BullMQ-backed background job queues on the application's existing Redis connection: named queues for transactional email, outbound webhook delivery, and usage-counter rollups, wired into the Nest module lifecycle so workers start and stop with the application.

Retries use bounded exponential backoff, exhausted jobs stay inspectable rather than silently disappearing, and queue key namespacing never collides with throttle or usage-limit keys sharing the same Redis instance.

## Requirements

### Requirement: Named BullMQ queues on shared Redis

The system SHALL provide BullMQ-backed job queues named at least `email`, `webhooks.outbound`, and `usage.rollups`, using the application's Redis connection with a dedicated key prefix that MUST NOT collide with throttle or usage-limit keys.

Queue producers and consumers SHALL be registered through a Nest module lifecycle so workers start with the application and shut down with it.

#### Scenario: Email job is enqueued

- **WHEN** application code enqueues a transactional email job with a provider-neutral payload
- **THEN** a job appears on the `email` queue and is processed by a worker that invokes the mail port

#### Scenario: Prefix isolates BullMQ keys

- **WHEN** Redis keys for BullMQ and for usage counters coexist
- **THEN** BullMQ keys use the configured prefix and usage-limit keys remain untouched by queue operations

### Requirement: Retry, backoff, and failed-job visibility

Failed jobs SHALL retry with bounded exponential backoff according to validated configuration. After exhausting retries, the job MUST remain visible as failed (BullMQ failed set or equivalent) and MUST emit a structured error log with the request or job correlation id when available.

#### Scenario: Transient failure retries

- **WHEN** an outbound webhook delivery fails with a retryable network error and attempts remain
- **THEN** the job is retried after a backoff delay and is not marked permanently failed

#### Scenario: Exhausted retries stay inspectable

- **WHEN** a job exhausts its retry budget
- **THEN** it is recorded as failed and an error-level log entry is emitted without swallowing the failure

### Requirement: Outbound webhook delivery jobs

The system SHALL support enqueueing outbound HTTP webhook deliveries (URL, body, optional signature headers) on `webhooks.outbound`. The worker MUST apply a request timeout and MUST NOT block the originating HTTP request thread beyond enqueue acknowledgement.

#### Scenario: Webhook enqueued from domain event

- **WHEN** a domain path requests outbound webhook delivery
- **THEN** the HTTP handler returns after enqueue (or equivalent non-blocking handoff) and the worker performs the POST

### Requirement: Usage rollup jobs do not replace synchronous enforcement

Jobs on `usage.rollups` MAY aggregate or snapshot usage counters for reporting. They MUST NOT be the mechanism that admits or rejects live requests; synchronous usage-limit consume semantics remain authoritative.

#### Scenario: Rollup failure does not open quotas

- **WHEN** a usage rollup job fails
- **THEN** live usage guards continue to enforce Redis counters and do not treat rollup failure as permission to skip metering

### Requirement: Queue metrics avoid high-cardinality labels

If queue depth or job outcome metrics are exported, label sets MUST NOT include unbounded identifiers such as user id, email, or full webhook URL with secrets.

#### Scenario: Job completed metric

- **WHEN** a job completes successfully and a metric is recorded
- **THEN** labels identify queue name and outcome class without per-user identifiers
