## ADDED Requirements

### Requirement: Queues, storage, flags, idempotency, and shutdown configuration

The validated environment schema SHALL include configuration for BullMQ (prefix, concurrency, retry/backoff defaults), storage driver and driver-specific groups, feature-flag env defaults as needed, idempotency TTL and key length bounds, and graceful-shutdown drain timeout. Every variable the application reads for these features MUST appear in `.env.example` without secret values.

Incomplete S3 or other conditionally required groups MUST fail boot when their driver is selected.

#### Scenario: Storage driver group enforced

- **WHEN** `STORAGE_DRIVER=s3` and the bucket is missing
- **THEN** boot validation fails naming the missing storage variables

#### Scenario: Shutdown drain configured

- **WHEN** a valid `SHUTDOWN_DRAIN_MS` (or equivalent) is set
- **THEN** typed config exposes the drain timeout to the shutdown path

#### Scenario: Example env documents new keys

- **WHEN** a contributor opens `.env.example`
- **THEN** queue, storage, feature-flag, idempotency, and shutdown variables are documented with safe placeholders
