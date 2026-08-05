## 1. Throttle policy gets its own counter

- [x] 1.1 Add a policy discriminator to `AppThrottlerGuard`, derived from the same `STRICT_THROTTLE_KEY` reflection `handleRequest` already reads, so the ceiling and the key cannot disagree about which policy applies
- [x] 1.2 Change `generateKey` to return `{policy}:{tracker}`, keeping one counter per policy per tracker rather than per route — exhausting burst on one default path must still protect the other default paths
- [x] 1.3 Scope the block key in `RedisThrottlerStorage` to the policy as well, so the `blockPttl > 0` short-circuit cannot deny routes governed by another policy
- [x] 1.4 Confirm the strict ceiling is still applied for both named throttlers (`burst` and `minute`) and that `handleRequest` reads the same policy the key was built from
- [x] 1.5 Update the class comment on `AppThrottlerGuard`, which currently states keys are "global per tracker" — that is the behaviour being changed and the reason needs to survive

## 2. MCP throttle distinguishes an outage from an exceedance

- [x] 2.1 Widen `McpThrottleService.consume`'s return type to carry a distinct storage-failure reason alongside `'RATE_LIMITED'`, keeping `null` for admitted
- [x] 2.2 Return that new reason from the catch block instead of `'RATE_LIMITED'`, leaving the fail-closed behaviour itself unchanged
- [x] 2.3 Map the new reason in `AgentPipelineService` to an MCP error distinct from the rate-limit denial, naming a temporary service condition
- [x] 2.4 Verify every call site of `consume` handles the widened union — a missed branch would silently admit or mislabel
- [x] 2.5 Resolve open question 2 — decide whether the storage-failure reason is recorded distinctly in `McpToolInvocation.errorCode`, and implement it or record why it waits for `admin-monitoring`

## 3. Usage limits adopt `BillingSubject`

- [x] 3.1 Replace `UsageSubject` with `BillingSubject` throughout `UsageLimitsService`, removing the parallel subject shape rather than adapting between the two
- [x] 3.2 Derive keys from the subject variant in `keysFor`: a user subject writes the user key; an organization subject writes both the org key and the calling member's user key
- [x] 3.3 Resolve ceilings per key scope in `ceilingFor` — the user key against the user's effective plan, the org key against the organization's, using `PlanResolutionService.resolve`'s existing `BillingSubject` support
- [x] 3.4 Replace `check()`'s `Math.max` across keys with a per-key comparison against that key's own ceiling, so an org count is never measured against a member's allowance
- [x] 3.5 Resolve the billing subject in `UsageLimitsGuard` via `BillingSubjectResolver`, mirroring `CreditsGuard`
- [x] 3.6 Thread the resolved subject through the MCP usage stage so tool invocations meter the same way as HTTP
- [x] 3.7 Update `snapshotsForUser` and any admin caller for the new subject type, keeping the existing read-only behaviour
- [x] 3.8 Confirm the org-billing feature flag now gates usage ceilings the same way it gates wallets, and that a user-only subject is unaffected when the flag is off

## 4. Rejected consumes leave counters unchanged

- [x] 4.1 Track every key incremented during a `consume` call so the rejection path can roll all of them back, not only the key that tripped
- [x] 4.2 Roll back the accumulated increments before throwing `USAGE_LIMIT_EXCEEDED` from the increment loop
- [x] 4.3 Rewrite `consume`'s doc comment — it currently claims "Atomically check-and-increment", which was never true — to describe compensation and name the residual (a crash between increment and rollback leaves a TTL-bounded counter high)
- [x] 4.4 Confirm the pre-check path still rejects without incrementing at all, which is the common exhausted case

## 5. Ceiling resolution: once per consume, inside the fail-closed boundary

- [x] 5.1 Memoize `ceilingFor` per `consume` call, keyed by subject scope, so the effective plan is resolved once per distinct scope instead of once per period per key
- [x] 5.2 Keep the memo call-scoped — deliberately not a cross-request cache, since subscription state changes via Stripe webhooks and a stale ceiling is a billing-correctness problem
- [x] 5.3 Move ceiling resolution inside the `try` that reports the fail-closed status, so a Postgres failure surfaces as `503 SERVICE_UNAVAILABLE` rather than `500 INTERNAL_ERROR`
- [x] 5.4 Confirm `check()` still fails closed for counter-store failures and that the two failure sources report the same status

## 6. Tests

- [x] 6.1 In `test/request-throttling.e2e-spec.ts`, assert default-policy traffic that exceeds the strict ceiling does not deny a first strict-policy request
- [x] 6.2 Assert a strict-policy block does not deny default-policy routes while they are under their own ceiling
- [x] 6.3 Assert the strict ceiling still bites on account routes, and that the existing shared-instance and forged-header cases still hold with the new key shape
- [x] 6.4 In `test/mcp.e2e-spec.ts`, assert a throttle-storage outage denies the tool with a reason distinct from a rate-limit exceedance, and that the adapter does not run
- [x] 6.5 Assert a genuine MCP exceedance still reports a rate-limit denial
- [x] 6.6 In `test/usage-limits.e2e-spec.ts`, assert an org-scoped consume is measured against the org's plan ceiling, not the calling member's
- [x] 6.7 Assert a consume rejected on the weekly ceiling leaves the daily counter unchanged
- [x] 6.8 Assert a consume rejected on an org ceiling leaves the user counter unchanged
- [x] 6.9 Assert a guard-metered request bound to an organization enforces the org counter
- [x] 6.10 Assert a ceiling-resolution failure returns `503`, distinct from `USAGE_LIMIT_EXCEEDED`
- [x] 6.11 Add a unit assertion that one `consume` resolves the effective plan once per distinct subject scope, so the N+1 cannot return unnoticed
- [x] 6.12 Check whether the `redis.quit()` pattern in the existing fail-closed tests still leaves the suite usable after the new cases are added, and reorder or isolate if not

## 7. Verification

- [x] 7.1 Run `openspec validate --all` and confirm both delta specs are clean
- [x] 7.2 Run the unit suite and the full e2e suite against Postgres and Redis
- [x] 7.3 Run the full e2e suite three times — the auth pass surfaced a cross-suite timing flake in `usage-limits`, which this change touches directly, so a single green run is not evidence
- [x] 7.4 Re-read the six hardened requirements against the code and confirm every scenario has something that would fail if the behaviour regressed
- [x] 7.5 Update `README.md` where it describes throttling and usage limits, if the per-policy counters and org ceiling resolution are not already stated accurately
