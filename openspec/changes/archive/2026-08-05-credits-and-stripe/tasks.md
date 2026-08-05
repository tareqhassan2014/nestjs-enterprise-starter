## 1. Schema, config, and dependencies

- [x] 1.1 Add Prisma models `CreditWallet`, `CreditLedgerEntry`, `StripeCustomer`, and `StripeProcessedEvent` (enums for ledger type; snake_case `@@map`; `User` relations; uniqueness on wallet user, ledger idempotency key, Stripe customer ids, event id)
- [x] 1.2 Generate and commit the migration; confirm no Connect/Tax/invoice-PDF speculative models are introduced
- [x] 1.3 Add the official Stripe Node SDK dependency; pin/document API version per current Stripe guidance
- [x] 1.4 Extend validated config with conditionally required Stripe top-up group (secret key, webhook secret, pack/price map, success/cancel URL inputs as needed) and optional `CREDITS_LOW_BALANCE_THRESHOLD`; update `.env.example`
- [x] 1.5 Add `INSUFFICIENT_CREDITS` to `ErrorCode` and map HTTP `402` without renaming existing codes

## 2. Credit ledger service

- [x] 2.1 Declare code-level `CREDIT_COSTS` catalogue (include `demo.paid` or equivalent) used by annotations and the demo route
- [x] 2.2 Implement `CreditService` (`grant`, `spend`, `refund`, `adjust`) with lazy wallet create, transactional balance updates, unique idempotency keys, and insufficient-balance failure
- [x] 2.3 Emit low-balance extension signal when threshold is configured and a spend crosses it
- [x] 2.4 Unit tests: grant/spend/refund/adjust; idempotent replay; insufficient balance; concurrent-safe single debit for one key; low-balance emit vs threshold absent

## 3. Credits gate and module wiring

- [x] 3.1 Implement `@CostsCredits` decorator typed against the credit-cost catalogue
- [x] 3.2 Implement `CreditsGuard` (no-op when undecorated; pre-handler atomic spend; `402` + `INSUFFICIENT_CREDITS`; consume AuthGuard principal only)
- [x] 3.3 Implement compensating refund on handler failure after pre-handler spend (interceptor or equivalent) with idempotent refund key
- [x] 3.4 Register the guard via `APP_GUARD` in `CreditsModule` imported after `UsageLimitsModule`; update `AuthorizationModule` comments so slot 6 is credits
- [x] 3.5 Unit tests: allow/deny by balance; unannotated pass-through; no session re-resolution; refund-on-handler-error path

## 4. Balance API and demo paid route

- [x] 4.1 Add authenticated enveloped `GET` balance endpoint (optional recent ledger read with capped page size)
- [x] 4.2 Add demo paid endpoint annotated with `@CostsCredits` demonstrating the full guard chain
- [x] 4.3 E2E: unauthenticated balance → `401`; sufficient balance → debit; insufficient → `402` `INSUFFICIENT_CREDITS` without handler side effects

## 5. Stripe top-up

- [x] 5.1 Implement Stripe client provider gated on config group presence; Customer get-or-create with `StripeCustomer` persistence
- [x] 5.2 Implement authenticated enveloped Checkout Session create for configured packs (server-side credits amount from pack map; omit `payment_method_types`)
- [x] 5.3 Implement webhook endpoint with raw-body signature verification; on paid Checkout completion grant credits with session-scoped idempotency key; record `StripeProcessedEvent`
- [x] 5.4 Document webhook path as outside the success envelope; return Stripe-minimal acknowledgements
- [x] 5.5 Fail closed when Stripe disabled (`503` / unavailable) on checkout create
- [x] 5.6 Tests: signature rejection; successful grant once; duplicate event/session no double-grant; unknown pack rejected; disabled Stripe behaviour

## 6. End-to-end and regression

- [x] 6.1 E2E guard order: usage-limit denial on a credits-annotated route does not debit; entitlement/RBAC denial does not debit
- [x] 6.2 E2E demo paid + top-up grant (mocked Stripe) then spend succeeds
- [x] 6.3 Confirm existing auth, plans, throttle, and usage-limit e2e suites still pass

## 7. Documentation

- [x] 7.1 README: credit wallet/ledger, `@CostsCredits` order, idempotency, Stripe Checkout top-up, webhook boundary, config group, non-goals (no subscription Billing sync / Connect / Tax)
- [x] 7.2 Document `INSUFFICIENT_CREDITS`, balance/checkout endpoints, and webhook envelope exception in the API contract section
