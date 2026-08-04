## ADDED Requirements

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

## MODIFIED Requirements

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
