## ADDED Requirements

### Requirement: Mounted authentication route surface

The authentication library's routes SHALL be served under `/api/auth`, outside the versioned `/api/v1` segment, so that the route contract does not move when the application's API version changes.

These routes are handled before Nest routing and MUST NOT be reachable under the versioned prefix. The application MUST NOT declare its own controller on a path the authentication handler owns.

#### Scenario: Auth route resolves outside the version segment

- **WHEN** a client posts credentials to `/api/auth/sign-in/email`
- **THEN** the authentication handler processes the request

#### Scenario: Auth surface is not versioned

- **WHEN** a client requests the same endpoint at `/api/v1/auth/sign-in/email`
- **THEN** the response is `404`

#### Scenario: Health and auth surfaces coexist

- **WHEN** the application is running
- **THEN** `/health/live`, `/health/ready`, and `/api/auth/*` all resolve, and none is served under `/api/v1`

### Requirement: Unparsed request body reaches the authentication handler

The authentication handler SHALL receive the raw, unconsumed request body. Global body parsing MUST be applied to every other path, and MUST be excluded from the authentication handler's paths.

Request correlation MUST be established before the authentication handler runs, so its log lines carry the same request identifier as the rest of the application.

#### Scenario: JSON credentials are accepted

- **WHEN** a client posts a JSON body to an authentication route
- **THEN** the handler reads the body successfully and the request does not hang

#### Scenario: Non-auth routes still receive a parsed body

- **WHEN** a client posts a JSON body to an application route under `/api/v1`
- **THEN** the handler receives a parsed, validated DTO

#### Scenario: Auth request is correlated

- **WHEN** a request to an authentication route is logged
- **THEN** its log lines carry a request identifier, and the response carries the matching `x-request-id` header

#### Scenario: Test harness matches the server

- **WHEN** the end-to-end test harness builds the application
- **THEN** it applies the same body-parsing and middleware arrangement as the production bootstrap, from a single shared definition

### Requirement: Email and password registration requires a verified address

The system SHALL support registration with an email address and password. A verification message SHALL be sent on registration, and a session MUST NOT be established for an account whose address is unverified.

Password length bounds MUST be enforced. Verification tokens MUST expire.

Following an already-used verification link MUST NOT change state and MUST NOT establish a session; it is not required to fail. Mail clients, link scanners, and double-clicks all re-fetch such links, so presenting an error for a verification that already succeeded would report a failure to a user who did nothing wrong. The security property required here is that a replay confers nothing, not that it is rejected. Password-reset tokens are stricter — see below — because replaying one would set a password twice.

#### Scenario: Registration sends a verification message

- **WHEN** a client registers with a valid email and password
- **THEN** the account is created and a verification message containing a verification link is dispatched

#### Scenario: Sign-in before verification

- **WHEN** a registered but unverified user signs in with correct credentials
- **THEN** no session is established and the response identifies the address as unverified

#### Scenario: Verification completes

- **WHEN** the user follows a valid, unexpired verification link
- **THEN** the address is marked verified and subsequent sign-in with correct credentials establishes a session

#### Scenario: Verification link replayed

- **WHEN** a verification link is followed a second time
- **THEN** no state changes, no session is established, and the account remains verified exactly once

#### Scenario: Verification token expired

- **WHEN** a verification link is followed after its lifetime has elapsed
- **THEN** the request is rejected and the user can request a new message

#### Scenario: Password below the minimum length

- **WHEN** registration is attempted with a password shorter than the configured minimum
- **THEN** the request is rejected and no account is created

### Requirement: Password reset is token-based, bounded, and non-disclosing

The system SHALL provide a password reset flow in which a reset token is delivered to the registered address. Reset tokens MUST be single-use and MUST expire.

A reset request for an address that is not registered MUST produce the same response as one for a registered address, so the endpoint does not disclose which addresses exist.

#### Scenario: Reset requested for a registered address

- **WHEN** a reset is requested for a registered address
- **THEN** a message containing a reset link is dispatched and the response indicates the request was accepted

#### Scenario: Reset requested for an unregistered address

- **WHEN** a reset is requested for an address with no account
- **THEN** no message is dispatched, and the response is indistinguishable from the registered case

#### Scenario: Reset completes and invalidates sessions

- **WHEN** a user completes a reset with a valid token and a new password
- **THEN** the password is changed, the token cannot be reused, and existing sessions for that user no longer authenticate

#### Scenario: Reset token expired

- **WHEN** a reset is attempted with a token past its lifetime
- **THEN** the request is rejected and the password is unchanged

### Requirement: Social sign-in with independently optional providers

The system SHALL support Google and Apple as social sign-in providers. Each provider SHALL be enabled by the presence of its complete credential group, with no separate enable flag to contradict the credentials.

A provider whose credentials are absent MUST NOT be advertised or routable. A provider whose credentials are partially supplied MUST fail validation at boot rather than fail at redirect time.

#### Scenario: Provider configured

- **WHEN** Google's complete credential group is present and a client begins the Google flow
- **THEN** the client is redirected to the provider and, on callback, a session is established

#### Scenario: Provider absent

- **WHEN** Apple's credentials are entirely absent and a client begins the Apple flow
- **THEN** the request is rejected and no redirect to the provider occurs

#### Scenario: Provider half-configured

- **WHEN** the application starts with a Google client ID present but its client secret missing
- **THEN** boot fails with an error naming the missing variable

#### Scenario: Social sign-in yields the same session type

- **WHEN** a user signs in through a social provider
- **THEN** the resulting session is the same kind of session as one from email and password, subject to the same expiry and revocation rules

### Requirement: Database-backed sessions with bounded lifetime

Sessions SHALL be persisted records with an expiry, so that they can be enumerated and revoked. Session expiry and refresh intervals SHALL come from validated configuration.

An expired session MUST NOT authenticate a request.

#### Scenario: Session established

- **WHEN** a user signs in successfully
- **THEN** a session record exists for that user and the request is authenticated on subsequent calls

#### Scenario: Session expired

- **WHEN** a request presents a session whose expiry has passed
- **THEN** the request is rejected as unauthenticated

#### Scenario: Session survives a cache restart

- **WHEN** the session cache is emptied and a client presents a session token issued before the flush
- **THEN** the request is still authenticated, because the durable store is authoritative

### Requirement: Two transports for one session

A session SHALL be presentable either as a browser cookie or as an `Authorization: Bearer` header carrying the same session token.

The cookie MUST be `HttpOnly` and signed, MUST use `SameSite=Lax`, and MUST carry the `Secure` attribute in every environment except local plain-HTTP development. Both transports MUST resolve to the same session, with the same expiry and the same revocation behaviour.

#### Scenario: Browser client

- **WHEN** a browser signs in and makes a subsequent request carrying only the session cookie
- **THEN** the request is authenticated

#### Scenario: Non-browser client

- **WHEN** a client presents the session token as `Authorization: Bearer <token>`
- **THEN** the request is authenticated as the same user

#### Scenario: Cookie attributes in production

- **WHEN** the application runs with secure cookies enabled and issues a session cookie
- **THEN** the `Set-Cookie` header carries `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`

#### Scenario: Cookie is not readable by script

- **WHEN** a session cookie is issued
- **THEN** it is marked `HttpOnly` so page scripts cannot read it

### Requirement: Session revocation takes effect immediately

Revoking a session SHALL stop it authenticating requests on the next request, with no cached-credential window.

Revocation MUST remove the session from both the durable store and any cache. A user SHALL be able to list and revoke their own sessions, and revoke all sessions other than the current one.

#### Scenario: Sign-out

- **WHEN** a user signs out and immediately reuses the same token
- **THEN** the request is rejected as unauthenticated

#### Scenario: Revoking another of the user's own sessions

- **WHEN** a user revokes a session listed under their account
- **THEN** a request presenting that session is rejected while the current session continues to work

#### Scenario: Revoke all other sessions

- **WHEN** a user revokes all sessions except the current one
- **THEN** every other session stops authenticating and the current one is unaffected

#### Scenario: No stale cache admits a revoked session

- **WHEN** a session is revoked and a request presents it immediately afterwards
- **THEN** it is rejected, and no cached copy authenticates it

### Requirement: The session cache never becomes a source of truth

Session lookups MAY be served from a cache, but the durable store SHALL remain authoritative. A cache miss or a cache failure MUST fall back to the durable store rather than deny the request.

A cache failure MUST be logged with the request identifier and MUST NOT be surfaced to the client as an authentication failure.

#### Scenario: Cache unavailable

- **WHEN** the session cache is unreachable and a request presents a valid, unexpired session
- **THEN** the request is authenticated from the durable store and a warning is logged

#### Scenario: Cache evicts an entry

- **WHEN** a cached session entry is evicted while the session is still valid
- **THEN** the next request re-reads the durable store and remains authenticated

#### Scenario: Cache failure is not a client error

- **WHEN** the session cache errors during a request from an authenticated user
- **THEN** the response is not `401` and does not mention the cache

### Requirement: Authenticated principal available through the request context

Once a request is authenticated, the principal's identifier SHALL be readable from the request context by any code in the call stack without being passed as an argument, and SHALL appear on log lines emitted for that request.

The context store MUST remain free of injected dependencies, so no provider becomes request-scoped. Unauthenticated requests MUST carry no principal.

#### Scenario: Nested service reads the principal

- **WHEN** a service several layers below the controller reads the current user identifier during an authenticated request
- **THEN** it receives the identifier of the authenticated user

#### Scenario: Log line identifies the actor

- **WHEN** a log entry is emitted during an authenticated request
- **THEN** it carries both the request identifier and the authenticated user identifier

#### Scenario: Public route

- **WHEN** a request to a public route is handled
- **THEN** the request context carries a request identifier and no user identifier

### Requirement: Unverified is distinguishable from unauthenticated

A request presenting a valid session for an account whose email is unverified SHALL be rejected with a distinct, documented error code rather than a generic authentication failure, because the client's remedy differs.

#### Scenario: Valid session, unverified address

- **WHEN** a request presents a valid session for an unverified account
- **THEN** the response identifies the cause as an unverified email and not as a missing or invalid session

#### Scenario: No session at all

- **WHEN** a request presents no session
- **THEN** the response is `401` with the unauthorized error code
