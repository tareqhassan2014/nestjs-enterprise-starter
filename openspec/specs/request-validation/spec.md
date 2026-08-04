# Request Validation

## Purpose

Every request payload is validated and transformed before a handler sees it, by default rather than by opt-in.

Unknown properties are rejected rather than silently stripped: for an API where fields carry money and permissions, a misspelled field name that quietly does nothing is a worse failure than a 400.

## Requirements

### Requirement: Global validation by default

Every endpoint SHALL validate its request payload through a globally registered validation pipe. Validation MUST apply without per-controller or per-handler opt-in.

#### Scenario: Payload satisfies the DTO

- **WHEN** a request body matches the handler's DTO
- **THEN** the handler receives a validated instance of the DTO class and executes normally

#### Scenario: Required field missing

- **WHEN** a request body omits a field the DTO marks required
- **THEN** the response is `400` and the handler never executes

### Requirement: Unknown properties rejected

The validation pipe SHALL strip properties not declared on the DTO and SHALL reject requests that carry them, rather than silently discarding them.

Silent stripping hides client bugs; a misspelled field name MUST surface as an error rather than as a no-op.

#### Scenario: Body contains an undeclared property

- **WHEN** a request body includes `role: "admin"` and the DTO does not declare `role`
- **THEN** the response is `400` and the error identifies the offending property

#### Scenario: Body contains a misspelled known property

- **WHEN** a request body sends `emial` instead of the declared `email`
- **THEN** the response is `400` naming `emial` as an unexpected property, and does not report `email` as merely missing in isolation

### Requirement: Payload transformation to declared types

The validation pipe SHALL transform incoming payloads into instances of their DTO classes and SHALL coerce primitive path and query parameters to their declared types.

Every query and path DTO MUST declare explicit validation decorators; implicit conversion performs coercion only and MUST NOT be relied on for rejection.

#### Scenario: Numeric query parameter

- **WHEN** a request sends `?page=2` and the DTO declares `page` as a `number`
- **THEN** the handler receives the number `2`

#### Scenario: Non-numeric value for a numeric parameter

- **WHEN** a request sends `?page=abc` and the DTO declares `page` as a validated integer
- **THEN** the response is `400` identifying `page` as invalid

#### Scenario: Boolean query parameter

- **WHEN** a request sends `?active=true` and the DTO declares `active` as a `boolean`
- **THEN** the handler receives the boolean `true`

### Requirement: Structured validation errors

Validation failures SHALL be surfaced through the standard error envelope with a stable error code and machine-readable, field-level details.

Each detail entry MUST identify the field, the violated constraint, and a human-readable message. Nested fields MUST be identified by dotted path.

#### Scenario: Multiple fields invalid

- **WHEN** a request body fails validation on two separate fields
- **THEN** the response is `400` with error code `VALIDATION_FAILED` and a `details` array containing one entry per failing field

#### Scenario: Nested field invalid

- **WHEN** validation fails on `address.postalCode` within a nested object
- **THEN** the corresponding detail entry identifies the field as `address.postalCode`

### Requirement: Documented bypass for non-first-party payloads

The system SHALL provide a documented mechanism for routes that must accept payloads the application does not model, such as third-party webhooks requiring an unparsed body.

Bypassing global validation MUST be explicit at the route level and MUST NOT weaken validation for any other route.

#### Scenario: Route opts out of global validation

- **WHEN** a route is marked as accepting a raw, unvalidated body
- **THEN** the global validation pipe does not reject its unknown properties
- **AND** all other routes continue to reject unknown properties
