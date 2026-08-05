## Why

Auditing `credits` and `stripe-topup` against `src/modules/credits` and `src/modules/billing` found three defects that move money in the wrong direction, and none of them is caught by a test.

The most serious: **an unpaid Checkout session grants credits.** The guard meant to prevent it cannot fire.

```ts
if (session.payment_status !== 'paid' && session.status !== 'complete') { return; }
```

For a `checkout.session.completed` event `status` is always `'complete'` — that is what the event means — so the second operand is always false, the `&&` short-circuits, and the early return is unreachable. The payment check is dead code. Stripe's `payment_status` is `'paid' | 'unpaid' | 'no_payment_required'`, and delayed-notification methods complete a session as `unpaid` and settle later. Those sessions are credited immediately. The only webhook test passes `payment_status: 'paid'`, so nothing fails.

## What Changes

**Only settled payments grant credits.** The condition becomes a positive test on `payment_status` (`paid` or `no_payment_required`), so an unpaid session is skipped rather than credited.

**Delayed payments grant when they settle.** `checkout.session.async_payment_succeeded` is handled alongside `checkout.session.completed`. This is coupled to the fix above and must land with it: tightening the payment check on its own would mean delayed-notification payments **never** grant credits at all — trading over-granting for silent non-delivery. The spec's "or equivalent paid completion event" already anticipated this; only one event type was ever wired. The canonical `stripe:checkout:{session.id}` idempotency key makes the two events converge on one grant.

**Idempotency replay validation notices the direction of an adjust.** `assertReplayMatches` compares owner, type, amount, and feature. For `adjust`, `amount` is `Math.abs(delta)` and `type` is always `'adjust'`, so `+100` and `-100` are indistinguishable. The admin adjust route takes a **client-supplied** idempotency key, so an operator reusing a ticket id gets the opposite adjustment silently treated as a replay — reported as success, balance unchanged, ledger showing the earlier entry. The stored signed delta becomes part of what a replay must match.

**A failed compensating refund stops being only a log line.** When the credits gate spends and the handler then throws, `CreditsRefundInterceptor` attempts a refund and, on failure, logs and rethrows the original error. The caller has been charged for work that did not happen, with no retry and nothing durable to reconcile from. The refund becomes durable through the existing queue infrastructure so it survives a transient database or Redis failure.

**A negative admin adjust can trip the low-balance signal.** `apply` emits only for `type === 'spend'`, so an operator debiting a wallet below the threshold emits nothing. The signal exists so somebody is warned before a customer is stranded; which internal operation caused the drop is not the interesting part.

### Non-goals

- **Organization top-up is out of scope, and is being recorded as a known limitation rather than fixed.** Credits support org-owned wallets and `CreditsGuard` spends from them, but `createCheckoutSession` takes a `userId` and grants `{ userId }` — so an org-primary customer spends org credits and can only ever top up their personal wallet. Closing that needs a pack-to-org mapping, a rule for which members may fund an org, and new session metadata: a feature, not a hardening pass. The `stripe-topup` spec is user-only throughout, so nothing currently claims otherwise; this change makes the limitation explicit instead of leaving it to be discovered.
- No change to the wallet/ledger schema, the `FOR UPDATE` locking strategy, or the XOR owner constraint.
- No Stripe Subscription lifecycle. Top-up grants credits only, as the spec already requires.
- No change to the webhook's non-enveloped transport contract.
- Not reworking `CreditService`'s dual `SubjectInput` shape (`subject` or bare `userId`). It is a deliberate back-compatibility affordance with a single resolution point, unlike the usage-limits case where a parallel subject type was genuinely stranded.

## Capabilities

### Modified Capabilities

- `stripe-topup`: the grant requirement gains the settlement condition it implies — a completed session that is not paid MUST NOT grant, and a payment that settles later MUST still grant exactly once through the same canonical key.
- `credits`: idempotency is required to distinguish operations that differ only in direction; a failed compensating refund must be durable rather than best-effort; the low-balance signal is required for any spend-like debit rather than only the `spend` type.

### New Capabilities

None.

## Impact

**Code**

- `src/modules/billing/stripe-topup.service.ts` — positive settlement test; handle `async_payment_succeeded`; record the processed event for both paths.
- `src/modules/credits/credit.service.ts` — persist and compare the signed delta on replay; emit low-balance for any debit.
- `src/modules/credits/credits-refund.interceptor.ts` — enqueue a durable refund when the inline attempt fails.

**Data**

Ledger rows already carry `amount` (absolute) and `type`. Distinguishing an adjust's direction needs the sign available at replay time. It is derivable from `balanceAfter` minus the previous balance, but that is not durable against interleaved entries — so the intended route is `metadata`, which exists and is already written on adjust. Recorded here because it is the one place this change touches stored data, and a migration should not be needed.

**Auth / billing / credits / throttle**

Billing and credits only. No auth, plan, throttle, or usage behaviour changes. The low-balance change increases how often the `email` queue bridge fires (admin debits now qualify), which is a deliberate widening.

**Risk**

The settlement fix is **restrictive**: sessions that are credited today stop being credited at completion time and are credited when they settle instead. For card payments — `payment_status: 'paid'` at completion — nothing changes. For delayed-notification methods the grant moves later, which is correct but is a visible timing change. If `async_payment_succeeded` were not delivered (webhook endpoint not subscribed to that event in the Stripe dashboard), those customers would never be credited — so the operator-facing note about which events to subscribe matters as much as the code.
