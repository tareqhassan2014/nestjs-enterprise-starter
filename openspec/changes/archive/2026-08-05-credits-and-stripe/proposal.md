## Why

Plans, entitlements, throttling, and usage limits are in place, but the reserved credit slot in the guard chain is empty and there is no way to charge for metered work beyond daily/weekly ceilings. Without a wallet, an immutable ledger, and a Stripe top-up path, forks will invent ad-hoc balance tables and webhook handlers that skip idempotency — and expensive features will either stay free or get bolted onto plan flags alone.

## What Changes

- **Credit wallet**: per-user balance derived from (or stored alongside) an append-only credit ledger; balance never mutated without a ledger entry.
- **Immutable credit ledger**: typed entries for grant, spend, refund, and adjust, each carrying an idempotency key so retries cannot double-apply.
- **CreditService**: domain API for grant / spend / refund / adjust with transactional balance updates and fail-closed insufficient-balance checks.
- **Feature cost catalogue**: code-declared features with integer credit costs; `@CostsCredits()` (or equivalent) selects the cost and drives the credits guard.
- **Credits gate**: Nest guard filling the final reserved slot after usage limits — annotated routes debit (or reserve-and-settle as designed) only after auth → RBAC → entitlements → throttle → usage have passed.
- **Stripe Checkout top-up**: authenticated flow to buy credit packs via Checkout Sessions; webhook completes the grant idempotently on `checkout.session.completed` (and related success events as designed).
- **Stripe customer linkage**: map Nest users to Stripe Customer ids; store session/payment identifiers needed for idempotent webhook processing.
- **Demo paid endpoint**: copy-paste pattern route that costs credits so forks see the full chain end-to-end.
- **Config**: Stripe secret/restricted key, webhook signing secret, public key (if needed), and pack/price configuration via env + `.env.example` (no secrets committed).
- **Optional low-balance hook**: extension point (event/log) when balance crosses a threshold — email/queue delivery deferred.

### Non-goals

- **No Stripe Billing subscription sync as the product source of truth.** Plan/subscription lifecycle already exists; this change may store Stripe customer/session ids and optionally grant credits on one-time Checkout, but it does not replace plan resolution with Stripe Subscription objects or drive `past_due` / cancel from invoices.
- **No Connect / marketplaces, Stripe Tax, Customer Portal, or invoice PDF APIs.** Top-up Checkout + signed webhooks only.
- **No org/team wallets.** Credits are user-scoped (same as current subscriptions).
- **No admin UI for ledger inspection** beyond what a minimal authenticated “my balance / recent ledger” read needs for the starter.
- **No real-money refunds through Stripe.** Ledger `refund` means restoring credits for a prior spend (product adjustment), not Stripe PaymentIntent refunds — document that fork decision separately.
- **No background job queue or email for low-balance** — only a hook/event surface if included; transactional mail remains unchanged unless a later change wires it.
- **No rewriting of RBAC, entitlements, throttle, or usage-limit semantics** — credits only consume the principal and run last.

## Capabilities

### New Capabilities

- `credits`: Per-user wallet and immutable ledger; CreditService (grant, spend, refund, adjust) with idempotency; code-declared feature cost catalogue; `@CostsCredits` decorator and Nest credits guard after usage limits; demo paid endpoint; optional low-balance extension point; minimal authenticated balance/ledger read.
- `stripe-topup`: Stripe Checkout Sessions for credit pack purchase; webhook signature verification and idempotent credit grants; Stripe Customer linkage to users; config for keys/webhook secret/pack price ids; no speculative Connect/Tax/Portal surface.

### Modified Capabilities

- `data-persistence`: Supersede the rule forbidding credit-ledger and Stripe payment-object models; extend schema + seed only as needed for packs/catalogue metadata (prefer code catalogue + env price ids over large seed matrices).
- `authorization`: Guard-chain documentation updates so credit checks are no longer a reserved empty slot — the credits guard is registered and ordered after usage limits.
- `api-response-envelope`: Error-code set gains stable identifiers for insufficient credits (and any Stripe top-up client-facing failures that belong in the envelope, distinct from `FORBIDDEN`, `ENTITLEMENT_DENIED`, and `USAGE_LIMIT_EXCEEDED`).
- `app-configuration`: Validated Stripe and credits-related env vars (keys, webhook secret, pack/price mapping, optional low-balance threshold) with `.env.example` updates.

## Impact

**Code**
- New: Prisma models/migrations for wallet/ledger (and Stripe customer / processed-event / checkout references as designed); `credits` module (service, guard, decorators, catalogue); `stripe` / top-up module (Checkout create, webhook controller outside or carefully exempt from body parsers that break signature verify); demo paid controller; tests for ledger idempotency and guard order.
- Modified: `AppModule` import/guard order; `AuthorizationModule` comments (credits slot filled); `ErrorCode` + filter mapping; config schema + `.env.example`; README.
- Dependencies: official Stripe Node SDK (latest stable / API version per Stripe guidance).

**APIs**
- Authenticated create-checkout (or top-up session) under `/api/v1` (enveloped).
- Stripe webhook endpoint — raw body + Stripe signature; response shape may be Stripe-minimal (document boundary like Better Auth if it bypasses the envelope).
- Authenticated balance (and optional recent ledger) read under `/api/v1`.
- Demo `@CostsCredits` route returns success only when spend succeeds; otherwise distinct insufficient-credits envelope code — handler does not run on denial if the guard spends/checks before the handler (design decides reserve vs check-then-handler-spend).

**Auth / billing / credits / throttle**
- Auth, RBAC, entitlements, throttle, and usage limits unchanged in behaviour; credits consume the already-resolved principal and run last so denials earlier never debit.
- Stripe is payment ingress for credits only in this change; plan gates remain the commercial packaging layer.
