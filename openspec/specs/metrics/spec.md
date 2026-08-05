# Metrics

## Purpose

In-process Prometheus-ready metrics with a configurable scrape endpoint outside the Nest success envelope, optional bearer authentication, and label cardinality safe for production.

## Requirements

### Requirement: Prometheus-ready in-process metrics

The system SHALL maintain an in-process metrics registry suitable for Prometheus scraping, including at least:

- HTTP request counters labeled by method, route template, and status class or status code
- Counters for enveloped `429` outcomes distinguished by `RATE_LIMITED` versus `USAGE_LIMIT_EXCEEDED` when known
- Counters for credit ledger mutation types (`grant`, `spend`, `refund`, `adjust`)

Metric label sets MUST NOT include unbounded per-user identifiers (user id, email, or raw request paths with ids).

#### Scenario: Request counter increments

- **WHEN** an enveloped Nest route completes with `200`
- **THEN** the HTTP request metric reflects an additional observation for that route template and success status

#### Scenario: 429 code distinguished

- **WHEN** a request is rejected with `RATE_LIMITED` and another with `USAGE_LIMIT_EXCEEDED`
- **THEN** metrics allow those outcomes to be counted separately

#### Scenario: No user-id labels

- **WHEN** the registered metric label names are inspected
- **THEN** they do not include `userId`, `email`, or equivalent high-cardinality subject identifiers

### Requirement: Metrics scrape endpoint outside the API envelope

When metrics exposure is enabled via validated configuration, the system SHALL serve a Prometheus text exposition endpoint on a stable non-versioned path (for example `/metrics`) that is excluded from the global `/api` prefix and from the success envelope.

When metrics exposure is disabled, the scrape path MUST NOT serve metric payloads.

#### Scenario: Enabled scrape returns Prometheus text

- **WHEN** metrics are enabled and a client GETs the scrape path
- **THEN** the response body is Prometheus text format and is not wrapped in `success` / `data` / `meta`

#### Scenario: Disabled scrape

- **WHEN** metrics are disabled and a client GETs the scrape path
- **THEN** the response is `404` (or otherwise does not expose metric series)

### Requirement: Optional scrape authentication

When a metrics bearer token is configured, scrape requests MUST present a matching `Authorization: Bearer` token or be rejected. When no token is configured and metrics are enabled, scrape MAY be open and MUST be documented as requiring network isolation.

#### Scenario: Valid bearer accepted

- **WHEN** metrics are enabled with a configured bearer token and the scrape request carries that token
- **THEN** the Prometheus payload is returned

#### Scenario: Missing bearer rejected

- **WHEN** metrics are enabled with a configured bearer token and the scrape request omits it
- **THEN** the response is `401` and no metric series body is returned
