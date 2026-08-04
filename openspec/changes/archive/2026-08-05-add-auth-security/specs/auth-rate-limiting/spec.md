## ADDED Requirements

### Requirement: Credential endpoints are rate limited more tightly than the rest of the auth surface

The authentication surface SHALL be rate limited, with stricter per-path limits on sign-in, sign-up, password reset, and two-factor verification than on the remainder of the surface.

Limits and windows SHALL come from validated configuration. Counters SHALL be held in shared storage so limits hold across application instances rather than per process.

#### Scenario: Sign-in attempts exceed the limit

- **WHEN** a client exceeds the configured sign-in attempt limit within the window
- **THEN** further attempts receive `429` until the window elapses

#### Scenario: Stricter than the general surface

- **WHEN** the configured limits are compared
- **THEN** the sign-in, sign-up, password reset, and two-factor verification paths permit fewer attempts per window than other authentication paths

#### Scenario: Limits are shared across instances

- **WHEN** two application instances serve attempts from the same client
- **THEN** the attempts count against one shared counter, not one per instance

#### Scenario: Window elapses

- **WHEN** a rate-limited client waits for the window to elapse
- **THEN** attempts are accepted again with no administrative action

#### Scenario: Application routes are unaffected

- **WHEN** the authentication rate limit is exhausted
- **THEN** requests to non-authentication routes are served normally

### Requirement: Repeated failures against one account trigger self-healing lockout

Failed sign-in attempts SHALL be counted per submitted account identifier, independently of the per-address limits, so a distributed attack on one account is throttled.

Once a threshold is crossed, the retry delay SHALL grow exponentially up to a configured cap. The lockout window MUST expire on its own, without administrative intervention, so an attacker cannot durably deny a legitimate user access to their account. A successful sign-in MUST clear the counter.

#### Scenario: Threshold crossed from many addresses

- **WHEN** failed attempts against a single account exceed the threshold, distributed across many client addresses
- **THEN** further attempts against that account are rejected with `429` even though no single address exceeded its own limit

#### Scenario: Delay grows with continued failure

- **WHEN** failures continue past the threshold
- **THEN** the required wait before the next accepted attempt increases, up to the configured cap and no further

#### Scenario: Lockout self-heals

- **WHEN** a locked-out account is left alone for the lockout window
- **THEN** sign-in is accepted again with no administrative unlock step

#### Scenario: Success resets the counter

- **WHEN** a user signs in successfully after some failed attempts below the threshold
- **THEN** the failure counter for that account is cleared

#### Scenario: Lockout is bounded, not sticky

- **WHEN** an attacker deliberately triggers lockout on a victim's account and stops
- **THEN** the victim regains access after the window elapses without contacting an administrator

### Requirement: Limiting reveals nothing about which accounts exist

Attempts against an unregistered identifier SHALL consume the same counters and produce the same response shape and status as attempts against a registered one.

Neither the response body, the status code, nor the presence of rate-limit metadata may differ based on whether the account exists.

#### Scenario: Unregistered identifier

- **WHEN** repeated sign-in attempts are made against an address with no account
- **THEN** counters are consumed and the responses are indistinguishable from attempts against a registered address

#### Scenario: Limiter is not an existence oracle

- **WHEN** an attacker compares rate-limit behaviour for a registered and an unregistered address
- **THEN** the number of attempts permitted and the resulting responses are the same for both

#### Scenario: Lockout state is not disclosed differently

- **WHEN** an account is locked out and an attempt is made against it, and separately against an unregistered address that has crossed the same threshold
- **THEN** both responses carry the same status and shape

### Requirement: Rate-limit identity is not client-controlled

Client address resolution SHALL be configurable and MUST NOT trust forwarded-address headers by default.

Forwarded headers SHALL be honoured only when the deployment is explicitly configured to trust its proxy, so a client cannot forge its own rate-limit identity to bypass limits. Express's proxy trust setting and the authentication library's address-header configuration MUST be driven from the same configuration value.

#### Scenario: Forwarded header not trusted by default

- **WHEN** proxy trust is not enabled and a client sends a forged forwarded-address header while exceeding the limit
- **THEN** the header is ignored and the client remains rate limited

#### Scenario: Proxy trust enabled

- **WHEN** proxy trust is enabled and requests arrive through a load balancer
- **THEN** the client address is taken from the forwarded header so limits apply per real client rather than per balancer

#### Scenario: One configuration value drives both

- **WHEN** proxy trust is configured
- **THEN** the framework's trust setting and the authentication library's address-header configuration agree, with no second place to configure it

### Requirement: Account identifiers are not stored in cleartext limiter keys

Counter keys derived from a submitted account identifier SHALL use a hash of the normalized identifier rather than the identifier itself.

Identifier normalization MUST be consistent, so case variations of the same address share one counter.

#### Scenario: Keyspace inspection

- **WHEN** the limiter's storage keyspace is inspected
- **THEN** no raw email address appears in a key

#### Scenario: Case variants share a counter

- **WHEN** failed attempts are made against the same address with differing letter case
- **THEN** they count against a single counter

### Requirement: A limiter outage fails closed on the auth surface only

If the rate limiter's storage is unavailable, authentication routes SHALL reject requests rather than serve them unmetered.

This failure posture MUST be confined to the authentication surface: other routes, whose access decisions rest on an authoritative store, MUST continue to be served. The condition MUST be logged with the request identifier.

#### Scenario: Limiter storage unavailable during sign-in

- **WHEN** the limiter's storage is unreachable and a sign-in is attempted
- **THEN** the request is rejected rather than processed without a limit check, and the condition is logged

#### Scenario: Other routes keep serving

- **WHEN** the limiter's storage is unreachable
- **THEN** authenticated requests to application routes are still served, resolving sessions from the authoritative store

#### Scenario: Distinct from an authentication failure

- **WHEN** a sign-in is rejected because the limiter is unavailable
- **THEN** the response indicates a temporary service condition rather than invalid credentials

### Requirement: Rate-limited responses tell the client when to retry

A rate-limited response SHALL use status `429` with the `RATE_LIMITED` error code where the application's error envelope applies, and SHALL indicate how long the client must wait.

#### Scenario: Retry timing communicated

- **WHEN** a request is rejected for exceeding a limit
- **THEN** the response indicates the wait before a retry will be accepted

#### Scenario: Code on enveloped routes

- **WHEN** a rate-limited response is produced on a route covered by the application error envelope
- **THEN** the body carries error code `RATE_LIMITED`
