## MODIFIED Requirements

### Requirement: Envelope opt-out for non-client consumers

The system SHALL provide a route-level marker that exempts a handler from the success envelope, for consumers that require a specific response shape.

Exempt handlers MUST still be covered by the global exception filter, and their errors MUST use the standard error envelope. Documented exceptions to that rule:

- The health endpoints: orchestrators require the health payload on failure as well as on success, so those routes bypass the error envelope too (see the `health-checks` capability).
- The metrics scrape endpoint: Prometheus scrapers require Prometheus text format, so that route bypasses the success envelope (see the `metrics` capability). Unauthorized scrape failures MAY return a non-enveloped `401`/`404` as designed for non-browser consumers.
- The mounted authentication surface: it is handled before Nest routing, so neither the interceptor nor the filter ever observes it, and it returns the authentication library's own shapes (see the `authentication` capability).

The authentication exception is a property of where those routes are handled, not a marker applied to them. No application-declared controller may rely on it, and any future middleware-level route surface MUST be documented here in the same way.

#### Scenario: Health endpoint is exempt

- **WHEN** a health endpoint marked as exempt is called
- **THEN** the response body is the health payload itself, with no `success`, `data`, or `meta` wrapper

#### Scenario: Metrics scrape is exempt from success envelope

- **WHEN** the metrics scrape path is called while metrics are enabled
- **THEN** the response body is Prometheus text (or a non-enveloped auth/disabled response), with no `success`, `data`, or `meta` wrapper

#### Scenario: Exempt handler throws

- **WHEN** an exempt handler throws an error
- **THEN** the response still uses the standard error envelope

#### Scenario: Authentication surface bypasses both envelopes

- **WHEN** an authentication route succeeds and, separately, fails
- **THEN** neither response carries the application's success or error envelope

#### Scenario: Marker is not what exempts the authentication surface

- **WHEN** the authentication routes are inspected
- **THEN** they carry no envelope opt-out marker, because they never reach the interceptor or the filter
