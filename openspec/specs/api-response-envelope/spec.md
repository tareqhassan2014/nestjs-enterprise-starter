# API Response Envelope

## Purpose

The uniform HTTP contract every endpoint shares: where routes live, what a success and a failure look like on the wire, and how a single request is correlated across its response and its log lines.

Clients branch on a stable `error.code`, never on prose or transport status. The envelope is applied globally so endpoints inherit the contract by default rather than by opting in.

## Requirements

### Requirement: Versioned API routing surface

All application routes SHALL be served under a global `/api` prefix with URI-based versioning, resolving at `/api/v1/...`, so that controllers declare their own path segment only.

Health endpoints SHALL be excluded from both the prefix and the version segment, so orchestrator probe paths remain stable across API versions. A default version MUST be configured so controllers require no explicit version declaration until a second version exists.

#### Scenario: Controller route resolves under the versioned prefix

- **WHEN** a controller declares the path `users` and a client requests `/api/v1/users`
- **THEN** the handler executes and returns its response

#### Scenario: Unversioned path is not served

- **WHEN** a client requests `/users` for a controller declaring the path `users`
- **THEN** the response is `404`

#### Scenario: Health endpoints bypass the prefix

- **WHEN** a client requests `/health/live` and `/health/ready`
- **THEN** both resolve, and neither is reachable at `/api/v1/health/live` or `/api/v1/health/ready`

### Requirement: The library-owned authentication surface is outside the application contract

Routes served by the mounted authentication library SHALL be documented as outside the application's request and response contract. They are handled before Nest routing and therefore receive neither the global validation pipe, the success envelope, nor the exception filter.

Their responses carry the authentication library's own shape, and their errors its own error identifiers. This boundary MUST be documented for clients rather than left to be discovered, and the application MUST NOT claim envelope uniformity across the whole origin.

The application's own authentication-adjacent endpoints — those it declares as controllers under the versioned prefix — remain fully inside the contract.

#### Scenario: Successful authentication response shape

- **WHEN** a client signs in successfully through the authentication surface
- **THEN** the response body is the authentication library's own shape, with no `success`, `data`, or `meta` wrapper

#### Scenario: Failed authentication response shape

- **WHEN** an authentication request fails
- **THEN** the response carries the authentication library's error shape, not the application error envelope

#### Scenario: First-party auth endpoint stays in the contract

- **WHEN** a client calls an application-declared endpoint under the versioned prefix that reads the current principal
- **THEN** the response uses the standard success envelope

#### Scenario: Boundary is documented

- **WHEN** the API documentation is read
- **THEN** it states which path prefix returns the library's shape and which returns the envelope

### Requirement: Uniform success envelope

Every successful API response SHALL be wrapped in a single envelope shape: `success: true`, a `data` field carrying the handler's return value, and a `meta` object.

Handlers MUST return their payload directly; wrapping is applied globally and MUST NOT be performed by handler code.

#### Scenario: Handler returns an object

- **WHEN** a handler returns `{ id: "1", name: "Ada" }`
- **THEN** the response body is `{ "success": true, "data": { "id": "1", "name": "Ada" }, "meta": { ... } }`

#### Scenario: Handler returns an array

- **WHEN** a handler returns a list of items
- **THEN** the array appears intact as `data` and is not renamed, flattened, or wrapped a second time

#### Scenario: Handler returns nothing

- **WHEN** a handler completes without returning a value
- **THEN** the response body still carries `success: true` and `meta`, with `data` set to `null`

### Requirement: Uniform error envelope

Every failed request SHALL produce an error envelope with `success: false` and an `error` object containing a stable string `code`, a human-readable `message`, and optional structured `details`.

The `code` MUST be a stable, documented identifier independent of the HTTP status, so clients branch on `code` rather than parsing messages.

#### Scenario: Known HTTP exception thrown

- **WHEN** a handler throws a not-found exception
- **THEN** the response is `404` with `success: false` and `error.code` set to `NOT_FOUND`

#### Scenario: Error response shape is consistent across sources

- **WHEN** errors originate from validation, from an explicitly thrown HTTP exception, and from an unexpected throw
- **THEN** all three responses share the same top-level envelope shape

### Requirement: Error codes for authentication and authorization outcomes

The error code set SHALL include stable identifiers for the authentication and authorization outcomes that clients must branch on, in addition to the existing codes.

Codes MUST remain independent of HTTP status. An unverified email, a required second factor, and a locked-out account MUST be distinguishable from one another and from a generic authentication failure, because each has a different client remedy.

#### Scenario: Missing or invalid session

- **WHEN** a request to a protected route presents no session
- **THEN** the response is `401` with error code `UNAUTHORIZED`

#### Scenario: Authenticated but unpermitted

- **WHEN** an authenticated caller lacks a required permission
- **THEN** the response is `403` with error code `FORBIDDEN`

#### Scenario: Unverified email

- **WHEN** a request presents a valid session for an account whose email is unverified
- **THEN** the response carries a distinct code identifying the unverified address, not `UNAUTHORIZED`

#### Scenario: Second factor outstanding

- **WHEN** a caller holds only a pending two-factor challenge and calls a protected route
- **THEN** the response carries a distinct code identifying that a second factor is required

#### Scenario: Account locked out

- **WHEN** a sign-in is refused because the account is in a lockout window
- **THEN** the response carries a distinct code identifying the lockout, separate from invalid credentials

#### Scenario: Existing codes unchanged

- **WHEN** the error code set is inspected
- **THEN** every code that existed before this change retains its identifier and meaning

### Requirement: Internal errors do not leak implementation detail

The global exception filter SHALL catch every unhandled error, including non-HTTP exceptions, and SHALL respond with a generic `500` error envelope carrying code `INTERNAL_ERROR`.

Stack traces, database error text, and internal identifiers MUST NOT appear in the response body in any environment. The full error, including stack, MUST be logged at `error` level with the request's correlation ID.

#### Scenario: Unexpected exception thrown in a service

- **WHEN** a service throws a plain `Error` with message `"connection string invalid: postgres://user:pw@host"`
- **THEN** the response is `500` with code `INTERNAL_ERROR` and a generic message
- **AND** the response body contains neither the original message nor a stack trace
- **AND** a log entry at `error` level records the original message, the stack, and the request ID

#### Scenario: Database constraint violation

- **WHEN** a Prisma unique-constraint violation is raised
- **THEN** the response is `409` with code `CONFLICT` and no raw database error text in the body

#### Scenario: Record not found from the database layer

- **WHEN** a Prisma "record not found" error is raised
- **THEN** the response is `404` with code `NOT_FOUND`

### Requirement: Request correlation identifier

Every request SHALL be assigned a correlation identifier, available to any code in the request's call stack without being passed as an argument, and included in the response envelope's `meta`, in the `x-request-id` response header, and in every log line emitted for that request.

An inbound `x-request-id` header SHALL be reused when it matches the accepted format; otherwise a new identifier MUST be generated. Client-supplied values MUST NOT be used for authorization or any purpose other than correlation.

#### Scenario: No inbound correlation header

- **WHEN** a request arrives without an `x-request-id` header
- **THEN** an identifier is generated and returned in both `meta.requestId` and the `x-request-id` response header

#### Scenario: Valid inbound correlation header

- **WHEN** a request arrives with a well-formed `x-request-id`
- **THEN** that same value appears in `meta.requestId`, the response header, and the request's log lines

#### Scenario: Malformed inbound correlation header

- **WHEN** a request arrives with an `x-request-id` that exceeds the length limit or contains disallowed characters
- **THEN** the supplied value is discarded, a new identifier is generated, and the request is not rejected

#### Scenario: Correlation ID reaches an error response

- **WHEN** a request fails with any error
- **THEN** the error envelope's `meta.requestId` matches the identifier in the log lines for that request

### Requirement: Envelope opt-out for non-client consumers

The system SHALL provide a route-level marker that exempts a handler from the success envelope, for consumers that require a specific response shape.

Exempt handlers MUST still be covered by the global exception filter, and their errors MUST use the standard error envelope. There are two documented exceptions to that rule:

- The health endpoints: orchestrators require the health payload on failure as well as on success, so those routes bypass the error envelope too (see the `health-checks` capability).
- The mounted authentication surface: it is handled before Nest routing, so neither the interceptor nor the filter ever observes it, and it returns the authentication library's own shapes (see the `authentication` capability).

The second exception is a property of where those routes are handled, not a marker applied to them. No application-declared controller may rely on it, and any future middleware-level route surface MUST be documented here in the same way.

#### Scenario: Health endpoint is exempt

- **WHEN** a health endpoint marked as exempt is called
- **THEN** the response body is the health payload itself, with no `success`, `data`, or `meta` wrapper

#### Scenario: Exempt handler throws

- **WHEN** an exempt handler throws an error
- **THEN** the response still uses the standard error envelope

#### Scenario: Authentication surface bypasses both envelopes

- **WHEN** an authentication route succeeds and, separately, fails
- **THEN** neither response carries the application's success or error envelope

#### Scenario: Marker is not what exempts the authentication surface

- **WHEN** the authentication routes are inspected
- **THEN** they carry no envelope opt-out marker, because they never reach the interceptor or the filter
