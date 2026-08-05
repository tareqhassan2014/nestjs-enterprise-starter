## ADDED Requirements

### Requirement: Cross-user credit inspection and adjust are admin concerns

Cross-user credit wallet and ledger inspection, and privileged grant/adjust on behalf of operators, SHALL be provided only through the admin monitoring HTTP surface and MUST require the corresponding admin permissions.

The authenticated self-service balance (and optional self ledger) read MUST remain limited to the caller's own wallet. `CreditService` remains the sole authority for balance mutations; admin routes MUST NOT bypass ledger idempotency or immutability rules.

#### Scenario: Self-service balance stays own-user

- **WHEN** an authenticated non-admin user requests the self-service credit balance endpoint
- **THEN** the response includes only that user's balance and does not expose another user's wallet

#### Scenario: Admin adjust uses CreditService semantics

- **WHEN** an admin adjust is applied through the admin API
- **THEN** a ledger entry is written with a unique idempotency key and the wallet balance matches `balanceAfter` on that entry
