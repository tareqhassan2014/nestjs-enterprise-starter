## MODIFIED Requirements

### Requirement: Credit mutations are idempotent

Every grant, spend, refund, and adjust MUST require an idempotency key. Replaying the same key with the same logical operation MUST NOT apply the balance change twice. The ledger MUST enforce uniqueness of idempotency keys.

Reuse of a key for a *different* logical operation MUST be rejected rather than absorbed as a replay. Distinguishing the two SHALL account for every field that determines the balance change, **including its direction**. An adjust records an absolute amount and a single type, so a credit and a debit of equal size are otherwise identical — and treating one as a replay of the other reports success while the requested change never happens and the ledger shows the opposite entry. This matters most where the key is supplied by a caller rather than derived by the system, as on the admin adjust route, because a reused ticket or reference id is an ordinary mistake rather than a hostile one.

Where a stored entry predates the recording of its direction, that entry's direction MAY be treated as unknown and the remaining fields compared alone. Rejecting every key whose stored entry lacks a recorded direction would refuse operations that were valid when they were written, turning a correctness improvement into an outage — so the guarantee applies to entries written with a direction, and the residual set of older keys SHALL be documented rather than silently exempted.

#### Scenario: Replay of the same spend key is a no-op success

- **WHEN** `spend` is invoked twice with the same idempotency key and the same amount for the same user
- **THEN** only one ledger entry exists and the balance reflects a single debit

#### Scenario: Stripe grant retry does not double-credit

- **WHEN** a top-up grant is applied again with the canonical Checkout-session idempotency key
- **THEN** the user's balance does not increase a second time

#### Scenario: Opposite adjust with a reused key is rejected

- **WHEN** an adjust of one direction is applied, and an adjust of the same size in the opposite direction is then submitted with the same idempotency key
- **THEN** the second request is rejected as a conflicting reuse of the key, rather than reported as a successful replay

#### Scenario: Identical adjust replay is still a no-op success

- **WHEN** the same adjust — same direction, same size, same owner — is submitted twice with one idempotency key
- **THEN** the balance changes once and the second call succeeds without applying it again

#### Scenario: A stored entry without a recorded direction falls back

- **WHEN** an adjust reuses the key of a stored entry that predates direction being recorded
- **THEN** the remaining fields are compared and the operation is treated as a replay rather than rejected, so keys written before the guarantee existed keep working

### Requirement: Credits gate runs after usage limits

The system SHALL provide a Nest credits gate registered after usage-limit enforcement. Routes annotated to cost credits MUST atomically debit the caller's wallet before the handler runs when balance is sufficient, and MUST reject with `INSUFFICIENT_CREDITS` without running the handler when balance is insufficient.

Routes without a credits annotation MUST pass through the gate unchanged. The gate MUST consume the already-resolved authentication principal and MUST NOT perform its own session lookup.

When a handler fails after a successful pre-handler spend, the system MUST attempt a compensating refund keyed for idempotency so a retry can spend again safely.

That attempt MUST NOT be the only chance the refund gets. If the inline compensation fails — the same database or cache trouble that broke the handler is the likeliest reason — the obligation SHALL be recorded durably so it can be retried, rather than left as a log line. The caller has already been charged for work that did not happen; discarding the correction on the first failure turns a transient fault into a silent, unreconcilable loss, and the compensating refund's idempotency key makes a later retry safe.

#### Scenario: Sufficient balance allows the handler

- **WHEN** an authenticated user with balance greater than or equal to the feature cost calls an annotated route
- **THEN** credits are spent once and the handler executes

#### Scenario: Insufficient balance denies before handler

- **WHEN** an authenticated user with balance below the feature cost calls an annotated route
- **THEN** the response is `402` with error code `INSUFFICIENT_CREDITS` and the handler never executes

#### Scenario: Unannotated routes are not charged

- **WHEN** an authenticated user calls a route without a credits annotation
- **THEN** the credits gate does not debit the wallet

#### Scenario: Earlier chain denials do not debit

- **WHEN** a request would fail RBAC, entitlements, throttle, or usage limits before the credits gate
- **THEN** no credit spend is attempted for that request

#### Scenario: Handler failure refunds the pre-handler spend

- **WHEN** the credits gate spends successfully and the handler then throws
- **THEN** a compensating refund is applied (or idempotently confirmed) so the net balance matches the pre-request balance aside from unrelated concurrent mutations

#### Scenario: A failed compensation survives for retry

- **WHEN** the handler throws and the inline compensating refund also fails
- **THEN** the refund obligation is recorded durably for retry under the same idempotency key, so the charge is not silently kept

#### Scenario: A retried compensation does not over-refund

- **WHEN** a durably recorded compensating refund is retried after the inline attempt had in fact succeeded
- **THEN** the shared idempotency key makes the retry a no-op and the wallet is credited once

### Requirement: Low-balance extension point

When a low-balance threshold is configured, the system SHALL emit a structured extension signal (domain event or equivalent) after a mutation that debits the wallet and leaves it at or below that threshold. The credits capability itself MUST NOT send SMTP directly. A separate integration MAY enqueue email via job-queues when feature flags or configuration enable that bridge.

Any debit SHALL qualify, not only the `spend` type. The signal exists so somebody is warned before a customer is stranded, and a wallet taken below the threshold by an operator's negative adjustment strands them exactly as a metered spend would. Which internal operation caused the drop is not what the warning is about.

#### Scenario: Threshold crossed emits signal

- **WHEN** a spend leaves the balance at or below the configured threshold
- **THEN** a low-balance signal is emitted with the billing subject identifier and resulting balance

#### Scenario: Negative adjust crossing the threshold emits the signal

- **WHEN** an adjust debits a wallet and leaves it at or below the configured threshold
- **THEN** a low-balance signal is emitted, as it would be for a spend of the same size

#### Scenario: Credits do not emit the signal

- **WHEN** a grant or refund leaves the balance at or below the threshold without debiting it
- **THEN** no low-balance signal is required, because the balance moved upward

#### Scenario: Threshold absent is silent

- **WHEN** no low-balance threshold is configured
- **THEN** spends do not require emission of a low-balance signal

#### Scenario: Optional email bridge enqueues

- **WHEN** the low-balance email bridge is enabled and a threshold-crossing signal is emitted
- **THEN** an `email` queue job is enqueued and the spend path does not call SMTP inline
