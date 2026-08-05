# Credits

## Purpose

Per-user pay-as-you-go credit wallet and immutable ledger, with a Nest gate after usage limits so annotated routes can debit catalogue costs before handlers run.

## Requirements

### Requirement: Per-user wallet with immutable ledger

The system SHALL maintain a per-user credit wallet whose balance is updated only together with an append-only ledger entry. Ledger entries MUST record type (`grant`, `spend`, `refund`, or `adjust`), a positive amount, `balanceAfter`, an optional feature identifier, and a unique `idempotencyKey`.

Balance MUST never go negative as a result of a successful spend. Wallets MAY be created lazily on the first credit mutation for a user.

#### Scenario: Grant increases balance and appends ledger

- **WHEN** credits are granted to a user with a new idempotency key
- **THEN** the wallet balance increases by the granted amount and a `grant` ledger entry exists with matching `balanceAfter`

#### Scenario: Spend decreases balance and appends ledger

- **WHEN** a spend succeeds for a user with sufficient balance
- **THEN** the wallet balance decreases by the spend amount and a `spend` ledger entry exists with matching `balanceAfter`

#### Scenario: Insufficient balance rejects spend

- **WHEN** a spend is attempted for more credits than the wallet holds
- **THEN** no ledger entry is written, the balance is unchanged, and the operation fails with insufficient-credits semantics

#### Scenario: Ledger entries are not updated in place

- **WHEN** a prior ledger entry is inspected after later mutations
- **THEN** its type, amount, and `balanceAfter` remain exactly as originally written

### Requirement: Credit mutations are idempotent

Every grant, spend, refund, and adjust MUST require an idempotency key. Replaying the same key with the same logical operation MUST NOT apply the balance change twice. The ledger MUST enforce uniqueness of idempotency keys.

#### Scenario: Replay of the same spend key is a no-op success

- **WHEN** `spend` is invoked twice with the same idempotency key and the same amount for the same user
- **THEN** only one ledger entry exists and the balance reflects a single debit

#### Scenario: Stripe grant retry does not double-credit

- **WHEN** a top-up grant is applied again with the canonical Checkout-session idempotency key
- **THEN** the user's balance does not increase a second time

### Requirement: Feature credit costs are declared in code

The system SHALL declare a code-level catalogue mapping feature identifiers to integer credit costs. Route annotations that cost credits MUST only accept identifiers from that catalogue.

#### Scenario: Annotated route uses catalogue cost

- **WHEN** a route is annotated to cost a catalogue feature
- **THEN** the credits gate uses that feature's declared integer cost

#### Scenario: Catalogue is the vocabulary

- **WHEN** a new billable feature is introduced
- **THEN** its cost is added to the code catalogue rather than invented as a free-form string in the decorator alone

### Requirement: Credits gate runs after usage limits

The system SHALL provide a Nest credits gate registered after usage-limit enforcement. Routes annotated to cost credits MUST atomically debit the caller's wallet before the handler runs when balance is sufficient, and MUST reject with `INSUFFICIENT_CREDITS` without running the handler when balance is insufficient.

Routes without a credits annotation MUST pass through the gate unchanged. The gate MUST consume the already-resolved authentication principal and MUST NOT perform its own session lookup.

When a handler fails after a successful pre-handler spend, the system MUST attempt a compensating refund keyed for idempotency so a retry can spend again safely.

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

### Requirement: Authenticated balance read surface

The system SHALL expose an authenticated, enveloped read of the caller's current credit balance under the versioned API prefix. The response MUST NOT include other users' balances or full cross-user ledger data.

#### Scenario: Caller reads own balance

- **WHEN** an authenticated user requests their credit balance
- **THEN** the success envelope carries that user's balance

#### Scenario: Unauthenticated balance read is rejected

- **WHEN** an unauthenticated client requests the credit balance endpoint
- **THEN** the response is `401`

### Requirement: Demo paid endpoint

The starter SHALL ship at least one demonstration route annotated to cost credits so forks can copy the auth → RBAC → entitlements → throttle → usage → credits pattern.

#### Scenario: Demo route charges catalogue cost

- **WHEN** an authenticated entitled user with sufficient balance calls the demo paid endpoint
- **THEN** the response succeeds and the wallet is debited by the demo feature's catalogue cost

### Requirement: Low-balance extension point

When a low-balance threshold is configured, the system SHALL emit a structured extension signal (domain event or equivalent) after a spend that leaves the wallet at or below that threshold. The signal MUST NOT itself send email or enqueue work as part of this capability.

#### Scenario: Threshold crossed emits signal

- **WHEN** a spend leaves the balance at or below the configured threshold
- **THEN** a low-balance signal is emitted with the user identifier and resulting balance

#### Scenario: Threshold absent is silent

- **WHEN** no low-balance threshold is configured
- **THEN** spends do not require emission of a low-balance signal
