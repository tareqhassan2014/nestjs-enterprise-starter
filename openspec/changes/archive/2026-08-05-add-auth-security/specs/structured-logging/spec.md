## MODIFIED Requirements

### Requirement: Automatic request logging with correlation

Completed HTTP requests SHALL be logged automatically with method, path, status code, and duration. Every log line emitted during a request SHALL carry that request's correlation identifier.

Log lines emitted during an authenticated request SHALL additionally carry the authenticated principal's identifier, so a request can be attributed to an actor without any call site passing it. Lines emitted before the principal is resolved — including the request-completion entry, which is written at response time by middleware that runs outside the guard chain — carry the correlation identifier alone, and are joined to the rest by it.

Health-check routes SHALL be excluded from automatic request logging so probe traffic does not dominate log volume.

#### Scenario: Request completes successfully

- **WHEN** a request completes with `200`
- **THEN** one entry records the method, path, status, and duration, and carries the request's correlation ID

#### Scenario: Log emitted deep in the call stack

- **WHEN** a service several layers below the controller logs a message during a request
- **THEN** that entry carries the same correlation ID as the request's completion entry

#### Scenario: Readiness probe

- **WHEN** an orchestrator polls the readiness endpoint
- **THEN** no automatic request-completion log entry is emitted for it

#### Scenario: Authenticated request identifies the actor

- **WHEN** a service logs a message during a request authenticated as a known user
- **THEN** that entry carries both the correlation ID and the authenticated user's identifier

#### Scenario: Unauthenticated request carries no actor

- **WHEN** a request to a public route is logged
- **THEN** its entries carry a correlation ID and no user identifier

#### Scenario: Entries are joinable across the request

- **WHEN** entries written before and after the principal is resolved are compared
- **THEN** they share the same correlation ID, so the actor can be attributed to the whole request

### Requirement: Redaction of sensitive fields

The logger SHALL redact sensitive values before serialization, covering at minimum the `authorization` header, request and response cookie headers, and any field named `password`, `token`, `secret`, `apiKey`, or `accessToken` appearing at the top level or nested within the log payload.

Redaction MUST additionally cover the credentials and secrets this application now handles: session tokens, the session cookie by name, one-time and time-based codes, two-factor provisioning secrets and backup codes, password-reset and email-verification tokens, OAuth client secrets and provider-issued tokens, and mail transport credentials.

Redaction MUST be configured centrally; it MUST NOT depend on individual call sites remembering to omit values.

Nesting depth is bounded by the redaction paths declared in configuration — the underlying engine has no unbounded-depth wildcard — and the declared paths MUST cover at least three levels. Deeper coverage is added by extending that configuration, never by redacting at a call site.

#### Scenario: Request carries a bearer token

- **WHEN** a request arrives with an `authorization: Bearer <token>` header and its completion is logged
- **THEN** the serialized entry does not contain the token value

#### Scenario: Object containing a password is logged

- **WHEN** a provider logs an object with a `password` property
- **THEN** the serialized entry shows the property as redacted and not its value

#### Scenario: Cookies present

- **WHEN** a request carries a `cookie` header and the response sets `set-cookie`
- **THEN** neither header's value appears in the serialized log entry

#### Scenario: Session cookie issued

- **WHEN** a sign-in response sets the session cookie and the exchange is logged
- **THEN** the session token value does not appear in the serialized entry

#### Scenario: Two-factor material logged

- **WHEN** an object containing a provisioning secret, a time-based code, or a backup code is logged
- **THEN** each is shown as redacted and not as its value

#### Scenario: Verification and reset tokens

- **WHEN** a verification or password-reset token passes through a logged payload
- **THEN** the serialized entry does not contain the token value

#### Scenario: Provider and transport secrets

- **WHEN** configuration or an error payload carrying an OAuth client secret or a mail transport password is logged
- **THEN** neither value appears in the serialized entry

#### Scenario: Redaction is central

- **WHEN** a new provider logs a payload containing any covered field name
- **THEN** it is redacted without that provider adding any redaction code
