## MODIFIED Requirements

### Requirement: Unverified is distinguishable from unauthenticated

A request presenting a valid session for an account whose email is unverified SHALL be rejected with a distinct, documented error code rather than a generic authentication failure, because the client's remedy differs.

The rejection SHALL carry status `403` with error code `EMAIL_NOT_VERIFIED`. Pinning the status matters as much as pinning the code: `401` invites a client to discard the session and re-authenticate, which cannot resolve an unverified address and loses a session that is in fact valid. The distinction is only useful if a client can branch on it without parsing prose, so both the status and the code are part of the contract.

#### Scenario: Valid session, unverified address

- **WHEN** a request presents a valid session for an unverified account
- **THEN** the response identifies the cause as an unverified email and not as a missing or invalid session

#### Scenario: Unverified rejection carries its own status and code

- **WHEN** a request presents a valid session for an unverified account
- **THEN** the response is `403` with error code `EMAIL_NOT_VERIFIED`

#### Scenario: No session at all

- **WHEN** a request presents no session
- **THEN** the response is `401` with the unauthorized error code
