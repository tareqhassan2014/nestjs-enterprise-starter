# Usage Dashboard

## Purpose

Admin-permission-gated APIs for daily/weekly usage snapshots, RPM-style request pressure summaries, and bounded top-429 offender lists for operations dashboards.

## Requirements

### Requirement: Daily and weekly usage snapshots for a subject

The system SHALL provide an admin-permission-gated, enveloped API that returns daily and weekly usage snapshots for a specified user and catalogue feature (or all catalogue features), using the same Redis key scheme and ceiling resolution rules as usage-limit enforcement.

#### Scenario: Admin reads a user's daily usage

- **WHEN** a caller with `admin:metrics:read` requests daily usage for a user and a catalogue feature
- **THEN** the success envelope includes used count, ceiling, remaining, and period identity for that day

#### Scenario: Non-admin denied

- **WHEN** an authenticated user without `admin:metrics:read` requests an admin usage snapshot
- **THEN** the response is `403` with error code `FORBIDDEN`

#### Scenario: Unknown feature rejected

- **WHEN** an admin usage request names a feature outside the usage catalogue
- **THEN** the response is a client error (validation or `BAD_REQUEST`) and no Redis key for an arbitrary string is created as a side effect of the read

### Requirement: RPM-style request pressure summary

The system SHALL provide an admin-permission-gated, enveloped summary of recent request rate pressure suitable for operations dashboards (for example requests per minute derived from metrics counters or an equivalent bounded window aggregate).

The summary MUST NOT require scanning unbounded Redis keyspaces on each request.

#### Scenario: Admin reads RPM-style summary

- **WHEN** a caller with `admin:metrics:read` requests the usage/traffic pressure summary
- **THEN** the success envelope includes a recent request-rate indicator for the application

#### Scenario: Summary does not SCAN throttle keys

- **WHEN** the pressure summary endpoint is implemented and invoked
- **THEN** it does not perform a Redis `KEYS`/`SCAN` of the entire throttle keyspace as its primary data path

### Requirement: Top 429 offenders

The system SHALL record bounded aggregates of subjects and/or routes that produce HTTP `429` responses with error codes `RATE_LIMITED` or `USAGE_LIMIT_EXCEEDED`, and SHALL expose an admin-permission-gated API returning the top offenders for a recent window.

Cardinality MUST be bounded (top-N with a configured maximum). User identifiers MUST NOT be exported as high-cardinality Prometheus label values for this purpose.

#### Scenario: Top RATE_LIMITED subjects

- **WHEN** multiple subjects have triggered `RATE_LIMITED` within the aggregation window and an admin with `admin:metrics:read` requests the top 429 list filtered to that code
- **THEN** the success envelope returns up to N subjects ordered by descending count

#### Scenario: Top USAGE_LIMIT_EXCEEDED separated from throttle

- **WHEN** an admin requests top offenders for `USAGE_LIMIT_EXCEEDED`
- **THEN** the list is not required to include pure `RATE_LIMITED` events, and vice versa when filtering by `RATE_LIMITED`

#### Scenario: Unauthenticated denied

- **WHEN** an unauthenticated client requests the top 429 endpoint
- **THEN** the response is `401` with error code `UNAUTHORIZED`
