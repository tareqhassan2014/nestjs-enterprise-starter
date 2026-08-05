## ADDED Requirements

### Requirement: Org-scoped wallets via billing subject

The system SHALL support credit wallets owned by either a user or an organization, with exactly one owner kind per wallet. When the billing subject resolver returns an organization subject, grant, spend, refund, adjust, and balance reads MUST operate on that organization's wallet. When the subject is a user, behaviour MUST match the existing per-user wallet rules.

Ledger entries MUST record the same owner as the wallet they affect. Idempotency keys remain unique across the ledger.

#### Scenario: Org spend debits org wallet

- **WHEN** a spend is invoked for an organization billing subject with sufficient org wallet balance
- **THEN** the organization wallet balance decreases and a `spend` ledger entry is written for that organization owner

#### Scenario: User subject unchanged

- **WHEN** a spend is invoked for a user billing subject
- **THEN** only that user's wallet is debited and no organization wallet is mutated

### Requirement: Credits gate uses billing subject

The credits gate SHALL resolve the billing subject from the authenticated principal and optional organization context before debiting. It MUST NOT hard-code user-only wallet lookup when an org-primary subject is active.

#### Scenario: Org-primary annotated route

- **WHEN** an entitled member in org-primary context calls a credits-annotated route with sufficient org balance
- **THEN** the organization wallet is debited and the handler executes

## MODIFIED Requirements

### Requirement: Per-user wallet with immutable ledger

The system SHALL maintain credit wallets whose balance is updated only together with an append-only ledger entry. Each wallet MUST be owned by exactly one billing owner: a user or an organization. Ledger entries MUST record type (`grant`, `spend`, `refund`, or `adjust`), a positive amount, `balanceAfter`, an optional feature identifier, a unique `idempotencyKey`, and the same owner as the wallet.

Balance MUST never go negative as a result of a successful spend. Wallets MAY be created lazily on the first credit mutation for that owner.

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

#### Scenario: Organization owner wallet

- **WHEN** credits are granted to an organization owner with a new idempotency key
- **THEN** the organization wallet balance increases and the ledger entry references that organization owner

### Requirement: Low-balance extension point

When a low-balance threshold is configured, the system SHALL emit a structured extension signal (domain event or equivalent) after a spend that leaves the wallet at or below that threshold. The credits capability itself MUST NOT send SMTP directly. A separate integration MAY enqueue email via job-queues when feature flags or configuration enable that bridge.

#### Scenario: Threshold crossed emits signal

- **WHEN** a spend leaves the balance at or below the configured threshold
- **THEN** a low-balance signal is emitted with the billing subject identifier and resulting balance

#### Scenario: Threshold absent is silent

- **WHEN** no low-balance threshold is configured
- **THEN** spends do not require emission of a low-balance signal

#### Scenario: Optional email bridge enqueues

- **WHEN** the low-balance email bridge is enabled and a threshold-crossing signal is emitted
- **THEN** an `email` queue job is enqueued and the spend path does not call SMTP inline
