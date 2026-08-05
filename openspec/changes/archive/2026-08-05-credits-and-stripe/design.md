## Context

Guard chain today: Auth → RBAC → Entitlements → Throttle → UsageLimits → *(empty credits)*. Plans and subscriptions provide commercial packaging and daily/weekly ceilings, but there is no balance, no ledger, and no payment ingress. `data-persistence` still forbids credit-ledger and Stripe payment models. The reserved credits slot and AGENTS.md “pay-as-you-go credits + Stripe” line are what this change fills.

Constraints: reuse Prisma + envelope; consume the AuthGuard principal only; keep RBAC / entitlements / throttle / usage semantics unchanged; Stripe is for **one-time credit top-up** via Checkout Sessions, not for replacing subscription lifecycle; secrets only via validated config + `.env.example` placeholders; no Connect, Tax, or Customer Portal.

## Goals / Non-Goals

**Goals:**

- Per-user wallet + immutable credit ledger with typed grant / spend / refund / adjust entries and unique idempotency keys.
- `CreditService` that applies balance changes only inside a DB transaction that writes the ledger first (or atomically with the wallet update).
- Code-declared feature → credit-cost catalogue and `@CostsCredits(feature)` Nest gate after usage limits.
- Stripe Checkout top-up for credit packs; signed webhooks; idempotent grants.
- Stripe Customer linkage to users; processed-event (or equivalent) dedupe.
- Demo paid endpoint and minimal authenticated balance read.
- Distinct `INSUFFICIENT_CREDITS` (and related) envelope codes.
- Optional low-balance extension point (emit event / structured log); no mail/queue wiring required.

**Non-Goals:**

- Stripe Billing as source of truth for plan `status` / invoices / Customer Portal.
- Org wallets, Connect, Tax, Payment Element custom UI, Stripe PaymentIntent refunds as product refunds.
- Admin ledger UI; background workers for low-balance email.

## Decisions

### 1. Wallet row + append-only ledger (not ledger-only balance)

**Choice:**

| Model | Role |
|-------|------|
| `CreditWallet` | `userId` PK/unique, `balance` (non-negative int), timestamps |
| `CreditLedgerEntry` | `id`, `userId`, `type` (`grant` \| `spend` \| `refund` \| `adjust`), `amount` (signed or absolute+direction — **absolute positive amount + type**), `balanceAfter`, `feature` nullable, `idempotencyKey` **unique**, `metadata` Json optional, `createdAt` |
| `StripeCustomer` | `userId` unique, `stripeCustomerId` unique |
| `StripeProcessedEvent` | `eventId` PK (Stripe event id), `type`, `processedAt` — webhook idempotency |

Table names snake_case via `@@map`. `User` gains relations. Ensure wallet exists lazily on first credit op (upsert) so signup need not create a zero wallet.

**Why not** ledger-only balance (SUM): every read is expensive and race-prone without locks. **Why not** mutate balance without ledger: forks lose auditability; Stripe retries become undiagnosable. **Why not** Redis balance: money-adjacent state belongs in Postgres with the ledger.

### 2. Idempotency is mandatory on every mutation

**Choice:** Every `CreditService` method requires an `idempotencyKey`. Unique constraint on `CreditLedgerEntry.idempotencyKey`. Replaying the same key returns the prior entry / no-op success (same amount/type); conflicting payload for an existing key fails loudly (`409` / `CONFLICT` or domain error — prefer reject with stable code if enveloped).

Key conventions:

| Source | Key pattern |
|--------|-------------|
| Guard spend | `spend:{requestId}:{feature}` |
| Handler refund after failed work | `refund:{requestId}:{feature}` |
| Stripe grant | `stripe:checkout:{sessionId}` (preferred) or `stripe:event:{eventId}` — **one canonical grant key per Checkout session** so event retries and session-completed duplicates collapse |
| Seed / admin grant | caller-supplied opaque key |

**Why not** optional idempotency: webhooks and client retries will double-grant.

### 3. CreditsGuard: check-and-spend before handler; refund on handler failure

**Choice:** For `@CostsCredits(feature)`:

1. Resolve cost from code catalogue (`CREDIT_COSTS`).
2. Atomically **spend** in a transaction (fail with `402` or `403` + `INSUFFICIENT_CREDITS` — **pick HTTP 402 Payment Required** for insufficient balance; document it).
3. Run handler.
4. If handler throws after spend, **refund** with linked idempotency key (best-effort in interceptor/`finally`); log if refund fails for operator follow-up.

Routes without the decorator: guard no-ops.

Handlers that need finer control (partial work) MAY call `CreditService` directly and omit the decorator; the demo uses the decorator path as the copy-paste pattern.

**Why not** spend-after-success only: concurrent requests overspend. **Why not** full saga/outbox: too heavy for the starter; request-scoped spend+refund covers the demo and most sync handlers.

### 4. Feature cost catalogue in code

**Choice:** Mirror permissions / entitlements / usage features:

```ts
export const CREDIT_COSTS = {
  'demo.paid': 1,
  // forks extend…
} as const;
```

`@CostsCredits` only accepts keys of that object. No DB table for costs in this change (env overrides optional later). Stripe **packs** (how many credits you buy) are config/env mapped to Stripe Price ids, not the cost catalogue.

### 5. Stripe Checkout Sessions for one-time top-up (not PaymentIntents UI)

**Choice:** Authenticated `POST /api/v1/billing/checkout` (name flexible) creates a Checkout Session:

- `mode: 'payment'`
- Line items from configured pack Price id(s)
- `client_reference_id` / `metadata`: `userId`, `creditPack`, `credits`
- `customer` = existing StripeCustomer or create+persist
- Success/cancel URLs from config
- Omit `payment_method_types` (Dashboard dynamic methods per Stripe guidance)
- Prefer restricted API key in docs; schema accepts `STRIPE_SECRET_KEY` (sk_/rk_)

Webhook `POST` (path e.g. `/api/v1/billing/webhook` or `/webhooks/stripe`):

- Raw body + `Stripe-Signature` verification with webhook secret
- On `checkout.session.completed` (paid): `CreditService.grant` with session-based idempotency key; insert `StripeProcessedEvent`
- Ignore/ack irrelevant events; never grant twice

**Envelope boundary:** Webhook responses are Stripe-minimal (`{ received: true }` / 400) — **outside** the success envelope, documented like Better Auth. Checkout create and balance reads stay enveloped.

**Why not** Payment Element embedded form in this change: more frontend surface than a starter needs. **Why not** sync Stripe Subscriptions → plan status: proposal non-goal; nullable subscription Stripe ids may already exist unused.

### 6. Conditionally required Stripe config group

**Choice:** Reuse the existing “conditionally required group” pattern:

- Absent entirely → app boots; credit ledger + `@CostsCredits` work; checkout/webhook routes fail closed with `503` / `SERVICE_UNAVAILABLE` or are unregistered when Stripe disabled.
- Partial (`STRIPE_SECRET_KEY` without `STRIPE_WEBHOOK_SECRET`, etc.) → boot fails naming the group.
- Members: secret key, webhook secret, at least one pack price id (or a JSON/map of packs), success/cancel base URLs (or derive from `APP_URL`). Publishable key optional if no client Stripe.js yet.

Credits-specific non-Stripe config (optional): `CREDITS_LOW_BALANCE_THRESHOLD` for the hook.

### 7. Guard registration fills slot 6

**Choice:** `CreditsModule` registers `APP_GUARD` → `CreditsGuard`. Import **after** `UsageLimitsModule` in `AppModule`. Update `AuthorizationModule` comment: slot 6 is credits, no longer reserved.

Denial table:

| Case | HTTP | `error.code` |
|------|------|----------------|
| Balance &lt; cost | 402 | `INSUFFICIENT_CREDITS` |
| Unknown feature key in decorator | boot/compile-time / 500 if somehow runtime | — |
| Stripe top-up while Stripe disabled | 503 | `SERVICE_UNAVAILABLE` |

`details` MAY include `required`, `balance` (not a full ledger dump).

### 8. Low-balance hook = domain event / Nest EventEmitter, not email

**Choice:** After a spend that leaves `balance <= threshold` (when threshold configured), emit `credits.low_balance` with `userId` and `balance`. No mailer call in this change. README notes forks can subscribe.

### 9. Minimal read APIs

**Choice:**

- `GET /api/v1/billing/credits` (or `/credits`) — `{ balance }` enveloped, authenticated.
- Optional `GET .../credits/ledger?limit=` — recent entries for the caller only (cap page size).
- No admin cross-user ledger in this change.

### 10. Seed

**Choice:** No mandatory credit grants on seed (avoid surprising balances). Optional demo grant behind a documented seed helper/test fixture. Pack Price ids are env-only, not seed rows.

## Risks / Trade-offs

**Spend-before-handler + refund-on-error** → Handler side effects that succeed after a late throw can leave credits refunded while work ran → Mitigation: keep demo handlers pure; document that long-running/external side effects should spend explicitly after success or use outbox in forks.

**Webhook before Checkout redirect** → User may see success URL before grant lands → Mitigation: grant on webhook; success page/API should poll balance or show “processing”; starter can document and return current balance on GET.

**Checkout metadata tampering** → Attacker cannot change Price credits if grant amount comes from **server-side pack map** keyed by Price id / pack slug in metadata that we verify against config, not from a client-supplied credit count alone.

**Idempotency key collisions across features** → Mitigation: namespaced key patterns including feature/session id.

**Partial unique “one wallet”** → Enforced by `userId` unique on `CreditWallet`.

**Stripe API version drift** → Pin SDK; document API version in README; prefer latest stable per Stripe guidance at apply time.

**Raw body for webhooks vs global JSON parser** → Same class of problem as Better Auth; verify signature on raw bytes; add Nest/Express middleware carve-out; e2e with Stripe test fixtures / signed payload helper.

## Migration Plan

1. Add Prisma models + migration; generate client.
2. Config schema + `.env.example` Stripe/credits group.
3. Implement `CreditService` + unit tests (idempotency, insufficient, refund).
4. Credits guard/decorators/module; wire AppModule order; error codes.
5. Stripe customer + Checkout + webhook; e2e with mocked Stripe / fixture signatures.
6. Demo paid route; balance read; README.
7. Rollback: reverse migration drops credit/stripe tables; disable Stripe env group; remove module imports — no data backfill required for greenfield starter.

## Open Questions

None blocking apply. Apply-time choices (exact path names, 402 vs 403 for insufficient credits — **design picks 402**, pack list shape in env) should follow existing Nest controller naming (`billing` vs `credits` module split: prefer `CreditsModule` for ledger/guard and `StripeBillingModule` or `BillingModule` for Checkout/webhook to keep Stripe optional).
