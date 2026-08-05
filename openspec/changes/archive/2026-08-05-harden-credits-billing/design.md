## Context

`credits` and `stripe-topup` are the last two stages of the commercial pipeline and the only ones that move money. Both specs validate; the code has three defects that a reader of the specs would assume were handled.

**The settlement guard cannot fire.** In `grantFromCheckout`:

```ts
if (session.payment_status !== 'paid' && session.status !== 'complete') { return; }
```

The event that reaches this code is `checkout.session.completed`, for which `status` is `'complete'` by definition. So `session.status !== 'complete'` is always false, the `&&` short-circuits, and the guard never returns early — the payment check is unreachable. Stripe types `payment_status` as `'paid' | 'unpaid' | 'no_payment_required'`, and delayed-notification methods complete a session while payment is outstanding. Those sessions are credited on the spot. The single webhook test passes `payment_status: 'paid'`, so nothing catches it.

This is `&&` where the intent was `||` — but rewriting it as `||` would be a second bug in the other direction (an unpaid session with a non-complete status would still slip through when both operands are negated the wrong way round). The clearer fix is to stop reasoning about it negatively at all: decide on `payment_status` alone, positively.

**Fixing that alone would break paying customers.** With settlement enforced, a delayed-notification session grants nothing at completion — and nothing later either, because only `checkout.session.completed` is handled. `checkout.session.async_payment_succeeded` exists in the installed Stripe types and is exactly the event that reports the later settlement. So the two fixes are one change: enforcing settlement without handling settlement-later converts over-granting into silent non-delivery, which is worse because the customer has paid.

**Idempotency cannot tell a credit from a debit.** `assertReplayMatches` compares owner, `type`, `amount`, and `feature`. `adjust` stores `amount: Math.abs(delta)` and `type: 'adjust'`, so `+100` and `-100` produce identical comparison inputs. The admin route takes the idempotency key **from the request body**, so an operator reusing a ticket id submits the opposite correction and receives a success whose ledger entry is the earlier, opposite one. Nothing in the response distinguishes that from having worked.

**A failed compensating refund is a log line.** `CreditsRefundInterceptor` catches its own failure, logs, and rethrows the handler's error. The likeliest cause of the refund failing is whatever broke the handler, so the two failures are correlated rather than independent — the case where compensation matters most is the case where it is most likely to be dropped.

Constraints: no schema change to wallet or ledger; the `FOR UPDATE` locking and XOR owner constraint stay; the webhook stays outside the response envelope; no Stripe Subscription lifecycle.

## Goals / Non-Goals

**Goals:**

- Credits are granted only for settled (or payment-not-required) sessions, decided positively on payment status.
- A payment that settles after completion still grants, exactly once, through the same canonical key.
- Idempotency rejects a reused key whose operation differs in direction, and still absorbs a genuine replay.
- A compensating refund that fails inline survives for retry instead of being discarded.
- A debit that crosses the low-balance threshold signals regardless of which mutation type caused it.

**Non-Goals:**

- **Organization top-up.** Recorded as a limitation, not fixed — see the proposal. It needs a pack-to-org mapping, an authorization rule for who may fund an org, and new session metadata.
- Reworking `CreditService`'s `SubjectInput` (`subject` or bare `userId`). One resolution point, deliberate back-compatibility; unlike the usage-limits case, nothing here is stranded.
- Changing the `FOR UPDATE` strategy or moving the processed-event write inside the grant transaction (see the risk note).
- Any new admin surface — `admin-monitoring` owns that and is the next change in this group.

## Decisions

### Decision 1: Decide settlement positively, on payment status alone

`grantFromCheckout` gains an explicit predicate: grant when `payment_status` is `'paid'` or `'no_payment_required'`, skip otherwise, logging the skip with the session id and status.

Positive rather than a corrected negative because the original bug is a reasoning error, not a typo. `payment_status !== 'paid' && status !== 'complete'` reads like "not paid and not finished, so bail", but the two clauses are about different things, and any two-clause negation over independent facts invites exactly this. A single positive test on the one field that describes payment has no such failure mode.

`'no_payment_required'` is included deliberately: a fully discounted pack (100% coupon) settles nothing and must still deliver, and omitting it would be the same class of bug pointed the other way — withholding credits from a legitimately completed purchase.

*Alternative considered:* re-fetch the session (or its PaymentIntent) from Stripe and trust that rather than the webhook payload. Rejected for this change — the payload is signature-verified, so it is already trustworthy, and an extra API call on the webhook path adds a failure mode and latency to a handler that must acknowledge quickly. Worth revisiting only if the payload proves insufficient.

### Decision 2: Handle the later-settlement event through the same grant path

`handleWebhook` routes both `checkout.session.completed` and `checkout.session.async_payment_succeeded` into `grantFromCheckout`. Both carry a `Checkout.Session`, so no second code path is needed, and the canonical `stripe:checkout:{session.id}` key means whichever arrives first grants and the other is an idempotent no-op.

The processed-event record stays keyed on `event.id`, so the two events are recorded separately — correct, since they are different deliveries. Convergence is the ledger's job, not the processed-event table's, and that is already how retries of a single event are handled.

**This has an operational precondition the code cannot enforce**: the Stripe endpoint must be subscribed to `checkout.session.async_payment_succeeded`. If it is not, a delayed payment settles and no event arrives, so a correct code path never runs. That is why the spec now requires the event list to be documented and why a task updates the operator-facing setup notes. A silent gap in a dashboard configuration is exactly the kind of thing this hardening pass exists to surface.

### Decision 3: Carry the adjust's direction in metadata, and compare it on replay

The ledger already has a `metadata` JSON column, written on adjust today. The signed delta goes there, and `assertReplayMatches` compares it when both the stored and incoming operations are adjusts.

Metadata rather than a new column because no migration is needed and the field exists for exactly this sort of operation detail. Metadata rather than deriving the sign from `balanceAfter` because that derivation needs the *previous* balance, which is only recoverable by walking the ledger and is not stable against interleaved entries from concurrent mutations.

Scoped to `adjust` on purpose. `grant` and `refund` are always credits and `spend` is always a debit, so for those the direction is implied by `type` and already compared. Only `adjust` carries a sign independent of its type, and only `adjust` takes a caller-supplied key on a route.

Entries written before this change have no stored delta. A replay against one of those cannot verify direction, so it MUST fall back to the current comparison rather than reject — refusing every pre-existing adjust key would turn a hardening change into an outage. This is a real gap in coverage for old rows, bounded and worth stating rather than papering over.

*Alternative considered:* store the signed value in `amount` and drop the absolute-value convention. Rejected — `amount` is documented as always positive with `type` carrying direction, several readers depend on that (including the admin ledger view and metrics), and changing it would be a data migration plus a contract change for a problem that metadata solves.

### Decision 4: A failed compensation is enqueued, not logged

`CreditsRefundInterceptor` keeps its inline attempt — the fast path stays fast and usually succeeds. When that attempt throws, it enqueues the refund on the existing BullMQ infrastructure with the same `refundIdempotencyKey`, so the retry is safe and converges on one refund whether or not the inline attempt partly succeeded.

Inline-first rather than always-enqueue because the common case is a handler-level failure with a healthy database, where refunding immediately keeps the wallet correct within the request and avoids a queue round trip. Enqueue-on-failure covers precisely the correlated case: the fault that broke the handler also breaks the compensation.

*Which queue.* `email`, `webhooks.outbound`, and `usage.rollups` exist. None is a credit-compensation queue, and overloading `webhooks.outbound` (an outbound delivery primitive) would be a misuse that the next reader has to decode. This needs its own named queue, registered the same way. Adding one is a small, additive change to `queues.config.ts` and `QueuesModule`, and it keeps the job's meaning legible in the dashboard.

*If the enqueue itself fails* — Redis down alongside Postgres — the interceptor logs at `error` as it does today. There is no third store to fall back to, and the honest position is that this residual exists and is bounded by the log. Naming it beats implying the problem is fully solved.

### Decision 5: Low-balance emits for any debit

The condition changes from `type === 'spend'` to "this mutation decreased the balance" — i.e. a negative applied delta — and still requires a configured threshold and a resulting balance at or below it.

Expressed as the delta's direction rather than by enumerating types, so a mutation type added later is covered by default. Emitting on a credit that happens to leave a low balance would be noise, which the direction test excludes naturally.

Consequence worth stating: the `email` bridge now fires for admin debits too. That is the intent — an operator debiting a wallet below the threshold strands the customer exactly as a metered spend would — but it does widen how often that queue job is produced.

## Risks / Trade-offs

- **The settlement fix withholds credits that are granted today** → Correct, and restrictive rather than permissive: for card payments (`paid` at completion) nothing changes; for delayed methods the grant moves to settlement. The exposure is an operator whose endpoint is not subscribed to the settlement event, which is why documentation is a task rather than an afterthought.
- **Pre-existing adjust ledger rows cannot have their direction verified** → Stated in Decision 3. Those keys fall back to today's comparison rather than being rejected. Bounded to keys already used before this change.
- **A new queue is one more moving part** → Additive, follows the established registration pattern, and the alternative (reusing `webhooks.outbound`) trades a legible name for a hidden coupling.
- **Enqueue-on-failure still has a residual** → If Redis is also down, the obligation is only in the log. No third store exists; named rather than hidden.
- **Low-balance signals become more frequent** → Deliberate widening; the bridge is already flag-gated for forks that do not want it.
- **The processed-event row is written outside the grant transaction** → Left as is. If the grant succeeds and the row write fails, Stripe retries and the canonical key makes the re-grant a no-op — the existing design is already safe here, and pulling the row inside the transaction would couple webhook bookkeeping to ledger locking for no gain. Recorded so the omission reads as considered.
- **Tightened scenarios will fail on first run** → Expected; those are the ones documenting behaviour the code lacks.

## Migration Plan

No schema migration. No configuration change beyond registering the new queue name. Adjust entries written before this change carry no signed delta and fall back to the existing replay comparison.

Deployment order does not matter, but the Stripe dashboard subscription for `checkout.session.async_payment_succeeded` should be in place **before** the settlement fix ships, or delayed-notification purchases in that window will complete unpaid, be correctly skipped, and have no event to grant on later. Rollback restores over-granting on unpaid sessions, which is worth knowing before rolling back.

## Open Questions

1. Should a skipped unpaid session be recorded somewhere an operator can see — a metric or a durable row — rather than only logged? Today an unpaid completion leaves no trace beyond a log line, so "customer says they paid and has no credits" is hard to distinguish from "event never arrived". Leaning toward a counter on the existing metrics surface, but it overlaps `admin-monitoring`, the next change in this group.
2. ~~Should the new compensation queue have a dead-letter or alerting path when its retries are exhausted?~~ → **Resolved: not here.** BullMQ retains failed jobs (`removeOnFail: 1000`), so an exhausted compensation is recoverable from the failed set — the gap is surfacing, not durability, and that is exactly the gap `email` and `webhooks.outbound` already have. Building an alerting path for one queue while its two siblings have none would make the inconsistency worse and would put queue observability inside a credits change. It belongs to a queues- or observability-focused change; recorded here so the omission is a decision rather than an oversight.

### Note on module wiring

`CreditsRefundInterceptor` (credits) now depends on `CreditCompensationQueueService` (queues), while `CreditCompensationProcessor` (queues) depends on `CreditService` (credits) — a dependency in both directions between the two modules. This works because both are `@Global()`, so neither imports the other, and because the pattern already existed: `LowBalanceEmailListener` in queues has depended on the credits module's event constant since the low-balance bridge shipped. The queue service is injected `@Optional()` regardless, so a fork that trims `QueuesModule` degrades to the previous log-only behaviour instead of failing to boot.
