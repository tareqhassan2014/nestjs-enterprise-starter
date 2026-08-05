## ADDED Requirements

### Requirement: Async usage rollups via job queues

The system SHALL be able to enqueue usage rollup or snapshot jobs on the `usage.rollups` queue for reporting or admin aggregation. Rollup jobs MUST NOT change the synchronous consume/reject behaviour of usage guards, and MUST NOT be required for period expiry (counters remain TTL self-expiring).

When an organization id is present on the usage subject, rollups MAY include organization-scoped counters using the existing key scheme.

#### Scenario: Rollup job enqueued without affecting live consume

- **WHEN** a rollup job runs successfully or fails
- **THEN** a concurrent live consume still reads and increments Redis counters under the same fail-closed rules as before

#### Scenario: Org counters eligible for rollup

- **WHEN** organization-scoped usage counters exist for a feature and period
- **THEN** a rollup job can read those keys without requiring a redesign of the subject key scheme
