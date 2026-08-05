## ADDED Requirements

### Requirement: OpenAPI documents Nest security schemes

The system SHALL publish an OpenAPI document that declares distinct security schemes for every Nest-accepted credential type:

- session cookie (Better Auth session cookie)
- session bearer (`Authorization: Bearer` with a session token)
- API-key bearer (`Authorization: Bearer` with an agent API key)

Scheme identifiers MUST be distinct so interactive docs can authorize each independently. The mounted Better Auth HTTP surface (`/api/auth/*`) MUST remain outside Nest OpenAPI path items; the document description MUST continue to state that boundary.

#### Scenario: Security schemes are listed

- **WHEN** the generated OpenAPI document is inspected
- **THEN** it defines separate security schemes for session cookie, session bearer, and API-key bearer

#### Scenario: Swagger Authorize offers each scheme

- **WHEN** Swagger UI is enabled and opened
- **THEN** the Authorize dialog exposes inputs for session cookie, session bearer, and API-key bearer independently

#### Scenario: Auth library paths are not Nest operations

- **WHEN** the OpenAPI `paths` object is inspected
- **THEN** it does not list Better Auth library routes under `/api/auth/*` as Nest operations

### Requirement: Operations declare applicable security

Nest controllers and operations that require authentication SHALL declare the security scheme(s) they accept in the OpenAPI document. Public Nest routes, health probes, metrics scrape, and the Stripe billing webhook MUST NOT be documented as requiring session or API-key security.

#### Scenario: Session-protected Nest route declares session security

- **WHEN** the OpenAPI document is inspected for an authenticated account or admin Nest route
- **THEN** that operation lists session cookie and/or session bearer security as applicable

#### Scenario: API-key-protected surface declares API-key security

- **WHEN** the OpenAPI document is inspected for a Nest route that accepts agent API keys
- **THEN** that operation lists the API-key bearer scheme

#### Scenario: Webhook is not session-secured in docs

- **WHEN** the OpenAPI document is inspected for the Stripe billing webhook operation (if present) or the document description covering it
- **THEN** the webhook is not marked as requiring session cookie, session bearer, or API-key security

### Requirement: Admin tagging remains compatible

OpenAPI Admin versus public tagging (owned by the admin-api capability) MUST remain satisfied when security schemes are added. Adding security schemes MUST NOT remove the `Admin` tag from `/api/v1/admin` routes or erase the non-envelope boundary description for `/api/auth/*`, `/health/*`, and the metrics scrape path.

#### Scenario: Admin tag survives scheme enrichment

- **WHEN** security schemes are present in the OpenAPI document
- **THEN** routes under `/api/v1/admin` still carry an `Admin` tag
