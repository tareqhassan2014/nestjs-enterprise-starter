## MODIFIED Requirements

### Requirement: Credential endpoints are rate limited more tightly than the rest of the auth surface

The authentication surface SHALL be rate limited, with stricter per-path limits on sign-in, sign-up, password reset, and two-factor verification than on the remainder of the surface.

Limits and windows SHALL come from validated configuration. Counters SHALL be held in shared storage so limits hold across application instances rather than per process.

Counter consumption SHALL be atomic: a single storage operation MUST both increment the counter and report the resulting value, so two concurrent attempts cannot each read the same pre-increment value and both be admitted. A check-then-write sequence over two round trips MUST NOT be used, because the ceiling it enforces is advisory under concurrency — which on the credential surface means the configured limit is not the limit.

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

#### Scenario: Concurrent attempts do not exceed the ceiling

- **WHEN** more simultaneous sign-in attempts than the configured strict maximum are issued against one credential path with no delay between them
- **THEN** no more than the configured maximum are admitted and the remainder receive `429`

#### Scenario: Counting is a single atomic operation

- **WHEN** the counter path is inspected
- **THEN** admission is decided from the return value of one atomic increment, and no code path reads a counter and writes it back as separate operations

### Requirement: Repeated failures against one account trigger self-healing lockout

Failed sign-in attempts SHALL be counted per submitted account identifier, independently of the per-address limits, so a distributed attack on one account is throttled.

Once a threshold is crossed, the retry delay SHALL grow exponentially up to a configured cap. The lockout window MUST expire on its own, without administrative intervention, so an attacker cannot durably deny a legitimate user access to their account. A successful sign-in MUST clear the counter.

The delay SHALL be the caller's actual remaining wait, not an advisory figure: the moment at which attempts are accepted again MUST be the moment the advertised delay elapses. A rejection issued by the lockout itself MUST NOT be counted as a further failure, so an attacker cannot inflate a victim's backoff by continuing to knock; a rejection issued by a rate limiter MUST likewise not be counted. Every other failed credential attempt MUST be counted, including the one that crosses the threshold, so that continued attempts after the delay elapses do escalate it.

Growth MUST be demonstrated through the HTTP surface. A test that calls the counting service directly demonstrates the decision function only, and cannot distinguish a delay that grows from one pinned at its first value by the surrounding request flow.

#### Scenario: Threshold crossed from many addresses

- **WHEN** failed attempts against a single account exceed the threshold, distributed across many client addresses
- **THEN** further attempts against that account are rejected with `429` even though no single address exceeded its own limit

#### Scenario: Delay grows with continued failure

- **WHEN** failures continue past the threshold, each attempt made after the previously advertised delay has elapsed
- **THEN** the required wait before the next accepted attempt increases, up to the configured cap and no further

#### Scenario: Growth is observed over HTTP

- **WHEN** the escalating delay is exercised by posting credentials to the sign-in path rather than by calling the counting service
- **THEN** successive advertised delays increase, so the escalation is a property of the request flow and not only of the decision function

#### Scenario: Advertised delay is the real wait

- **WHEN** a locked-out caller waits exactly the advertised delay and attempts again
- **THEN** the attempt is admitted and evaluated, rather than rejected because a longer window was still in force

#### Scenario: Knocking does not extend the lock

- **WHEN** a caller already inside a lockout window keeps attempting throughout it
- **THEN** those rejections do not increase the delay, and the window ends when it would have ended had the caller stopped

#### Scenario: Lockout self-heals

- **WHEN** a locked-out account is left alone for the lockout window
- **THEN** sign-in is accepted again with no administrative unlock step

#### Scenario: Success resets the counter

- **WHEN** a user signs in successfully after some failed attempts below the threshold
- **THEN** the failure counter for that account is cleared

#### Scenario: Lockout is bounded, not sticky

- **WHEN** an attacker deliberately triggers lockout on a victim's account and stops
- **THEN** the victim regains access after the window elapses without contacting an administrator

### Requirement: A limiter outage fails closed on the auth surface only

If the rate limiter's storage is unavailable, authentication routes SHALL reject requests rather than serve them unmetered.

This failure posture MUST be confined to the authentication surface: other routes, whose access decisions rest on an authoritative store, MUST continue to be served. The condition MUST be logged with the request identifier.

Fail-closed MUST be a property of the counter path rather than a stated intention. A storage error encountered while consuming a counter MUST propagate, and MUST NOT be converted into a value that reads as an unused window — a counter absent because storage is unreachable is indistinguishable, to any caller that treats a miss as zero, from a counter absent because no attempt has been made. Where one storage adapter serves both session caching and limiter counting, the session operations MUST keep failing open and the counting operation MUST fail closed; the two postures MUST NOT be collapsed into one because they protect opposite properties.

#### Scenario: Limiter storage unavailable during sign-in

- **WHEN** the limiter's storage is unreachable and a sign-in is attempted
- **THEN** the request is rejected rather than processed without a limit check, and the condition is logged

#### Scenario: A storage error is not an empty window

- **WHEN** the storage backing the limiter raises an error while a counter is consumed
- **THEN** the error propagates and the attempt is refused, rather than the absent counter being read as a fresh window and the attempt admitted

#### Scenario: Session reads still fail open during the same outage

- **WHEN** the shared storage is unreachable and an already-authenticated request presents a valid session
- **THEN** the session resolves from the durable store and the request is served, even though credential attempts are being refused

#### Scenario: Other routes keep serving

- **WHEN** the limiter's storage is unreachable
- **THEN** authenticated requests to application routes are still served, resolving sessions from the authoritative store

#### Scenario: Distinct from an authentication failure

- **WHEN** a sign-in is rejected because the limiter is unavailable
- **THEN** the response indicates a temporary service condition rather than invalid credentials
