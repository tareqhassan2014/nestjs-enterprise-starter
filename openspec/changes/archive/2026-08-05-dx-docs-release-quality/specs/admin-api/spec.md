## MODIFIED Requirements

### Requirement: OpenAPI documents Admin versus public surfaces

The system SHALL publish OpenAPI documentation that tags administrative routes distinctly from end-user Nest routes (at minimum an `Admin` tag on `/api/v1/admin` controllers).

The documentation MUST state that the mounted authentication library surface, health probes, and the metrics scrape path are outside the Nest success-envelope contract.

Detailed Nest security schemes (session cookie, session bearer, API-key bearer) and per-operation security declarations are owned by the `openapi-contract` capability. This requirement owns Admin versus public tagging and the non-envelope boundary description only.

#### Scenario: Admin routes carry the Admin tag

- **WHEN** the generated OpenAPI document is inspected
- **THEN** routes under `/api/v1/admin` are associated with an `Admin` tag

#### Scenario: Boundary paths are described

- **WHEN** the OpenAPI description or linked API contract documentation is read
- **THEN** it identifies `/api/auth/*`, `/health/*`, and the metrics scrape path as outside the enveloped Nest API contract

#### Scenario: Swagger can be disabled by configuration

- **WHEN** Swagger/OpenAPI UI exposure is disabled via validated configuration
- **THEN** the interactive docs endpoint is not served

#### Scenario: Security schemes are not required solely by this capability

- **WHEN** the OpenAPI document is validated against admin-api requirements
- **THEN** satisfaction of Admin tagging and boundary description does not depend on re-specifying the full security-scheme catalogue here
