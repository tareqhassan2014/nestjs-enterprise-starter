## ADDED Requirements

### Requirement: Admin HTTP surface under the versioned API

The system SHALL expose administrative Nest controllers under the versioned path prefix `/api/v1/admin`. Every admin business route MUST require an authenticated session and at least one declared admin permission via the existing authorization annotations.

Admin routes MUST use the standard success and error envelopes. They MUST NOT be marked public.

#### Scenario: Unauthenticated admin call is rejected

- **WHEN** a client calls an `/api/v1/admin` route without a session
- **THEN** the response is `401` with error code `UNAUTHORIZED` and the handler never executes

#### Scenario: Authenticated caller without admin permission is rejected

- **WHEN** an authenticated user who lacks the route's required admin permission calls that admin route
- **THEN** the response is `403` with error code `FORBIDDEN` and the handler never executes

#### Scenario: Permitted admin call succeeds

- **WHEN** an authenticated user holding the required admin permission calls the admin route
- **THEN** the handler executes and the response uses the success envelope

### Requirement: Admin routes use permissions rather than role-only gates

Admin controllers SHALL declare requirements with permission annotations typed against the code-declared vocabulary. Role-only gates MUST NOT be the sole protection for admin monitoring routes, so operators can split metrics readers from credit adjusters without deploying code that hard-codes the `admin` role name.

#### Scenario: Metrics permission without adjust permission

- **WHEN** a user holds `admin:metrics:read` but not `admin:credits:adjust` and calls a credit-adjust admin route
- **THEN** the response is `403` with error code `FORBIDDEN`

#### Scenario: Adjust permission allows mutation route

- **WHEN** a user holds `admin:credits:adjust` and calls the credit-adjust admin route with a valid body
- **THEN** the authorization stage admits the request (subject to validation and domain rules)

### Requirement: OpenAPI documents Admin versus public surfaces

The system SHALL publish OpenAPI documentation that tags administrative routes distinctly from end-user Nest routes (at minimum an `Admin` tag on `/api/v1/admin` controllers).

The documentation MUST state that the mounted authentication library surface, health probes, and the metrics scrape path are outside the Nest success-envelope contract.

#### Scenario: Admin routes carry the Admin tag

- **WHEN** the generated OpenAPI document is inspected
- **THEN** routes under `/api/v1/admin` are associated with an `Admin` tag

#### Scenario: Boundary paths are described

- **WHEN** the OpenAPI description or linked API contract documentation is read
- **THEN** it identifies `/api/auth/*`, `/health/*`, and the metrics scrape path as outside the enveloped Nest API contract

#### Scenario: Swagger can be disabled by configuration

- **WHEN** Swagger/OpenAPI UI exposure is disabled via validated configuration
- **THEN** the interactive docs endpoint is not served
