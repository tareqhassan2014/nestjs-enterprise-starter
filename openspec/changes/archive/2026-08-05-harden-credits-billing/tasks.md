## 1. Only settled sessions grant credits

- [x] 1.1 Replace the unreachable negative guard in `grantFromCheckout` with a positive predicate: grant when `payment_status` is `paid` or `no_payment_required`, skip otherwise
- [x] 1.2 Include `no_payment_required` deliberately, so a fully discounted pack still delivers, and comment why omitting it would be the same class of bug reversed
- [x] 1.3 Log a skipped session at `warn` with the session id and payment status, so an unpaid completion is traceable rather than invisible
- [x] 1.4 Comment the original defect at the call site — `&&` over two independent facts made the payment check unreachable — so the positive form is not "simplified" back later

## 2. Delayed settlement grants through the same path

- [x] 2.1 Route `checkout.session.async_payment_succeeded` into `grantFromCheckout` alongside `checkout.session.completed`, verifying both event types carry a `Checkout.Session` payload
- [x] 2.2 Confirm the canonical `stripe:checkout:{session.id}` key is unchanged for both paths, so whichever event arrives first grants and the other is an idempotent no-op
- [x] 2.3 Keep the processed-event record keyed on `event.id` so the two deliveries are recorded separately — convergence is the ledger's job, not this table's
- [x] 2.4 Document the required Stripe event subscriptions where an operator configuring the webhook will read them, calling out that a missing `async_payment_succeeded` subscription means delayed payments never grant

## 3. Idempotency notices the direction of an adjust

- [x] 3.1 Persist the signed delta in the ledger entry's existing `metadata` on `adjust`, keeping `amount` absolute and `type` as the direction carrier for every other mutation
- [x] 3.2 Compare the stored signed delta in `assertReplayMatches` when both stored and incoming operations are adjusts, rejecting a reused key whose direction differs
- [x] 3.3 Fall back to the existing comparison when the stored entry has no signed delta, so keys used before this change are not rejected — and comment that this leaves old rows unverifiable
- [x] 3.4 Confirm an identical adjust replay (same direction, size, owner) is still a no-op success rather than a conflict
- [x] 3.5 Leave `grant`, `spend`, and `refund` comparison untouched — their direction is implied by `type` and already compared

## 4. A failed compensation survives for retry

- [x] 4.1 Register a dedicated credit-compensation queue name in `queues.config.ts` and `QueuesModule`, following the existing `email` / `webhooks.outbound` / `usage.rollups` pattern
- [x] 4.2 Add a processor that replays the refund through `CreditService.refund` with the supplied idempotency key, so a retry converges on one refund
- [x] 4.3 Keep `CreditsRefundInterceptor`'s inline attempt as the fast path, and enqueue only when it throws
- [x] 4.4 Pass the same `refundIdempotencyKey` to the queued job so the inline attempt and the retry cannot double-refund
- [x] 4.5 Keep the original handler error as the thrown error — compensation must not replace what the caller sees
- [x] 4.6 Log at `error` when the enqueue itself fails, and comment that this residual is bounded by the log because no third store exists
- [x] 4.7 Resolve open question 2 — decide whether exhausted compensation retries need an alerting path here or belong to a queues-focused change, and record which

## 5. Low-balance signals on any debit

- [x] 5.1 Change the emission condition from `type === 'spend'` to "the applied delta decreased the balance", keeping the configured-threshold and at-or-below checks
- [x] 5.2 Confirm a grant or refund that leaves a low balance does not emit, since the balance moved upward
- [x] 5.3 Note in the code that the `email` bridge now fires for admin debits too, as a deliberate widening rather than an accident

## 6. Tests

- [x] 6.1 In `test/credits-stripe.e2e-spec.ts`, assert a completed session with `payment_status: 'unpaid'` grants nothing and leaves the balance unchanged
- [x] 6.2 Assert a session with `payment_status: 'no_payment_required'` does grant
- [x] 6.3 Assert an `async_payment_succeeded` event grants for a session that completed unpaid
- [x] 6.4 Assert completion followed by later settlement for the same session credits exactly once in total
- [x] 6.5 Verify the unpaid case actually fails against the pre-change code, so the test is proving the fix rather than decorating it
- [x] 6.6 Add a unit assertion that an opposite-direction adjust reusing an idempotency key is rejected as a conflict
- [x] 6.7 Add a unit assertion that an identical adjust replay is still a no-op success
- [x] 6.8 Add an assertion that a replay against a legacy adjust entry with no stored delta falls back rather than rejecting
- [x] 6.9 Add a test that a failed inline compensation enqueues a durable refund carrying the same idempotency key
- [x] 6.10 Add a test that the queued compensation is a no-op when the inline refund had in fact succeeded
- [x] 6.11 Add a test that a negative admin adjust crossing the threshold emits the low-balance signal, and that a grant leaving a low balance does not

## 7. Verification

- [x] 7.1 Run `openspec validate --all` and confirm both delta specs are clean
- [x] 7.2 Run the unit suite and the full e2e suite against Postgres and Redis
- [x] 7.3 Run the full e2e suite three times — this change touches the credits suite and adds a queue, and a single green run has not been sufficient evidence in this group
- [x] 7.4 Re-read the four hardened requirements against the code and confirm every scenario has something that would fail if the behaviour regressed
- [x] 7.5 Update `README.md` where it describes credits, top-up, and the webhook, including the required Stripe event subscriptions and the org top-up limitation
