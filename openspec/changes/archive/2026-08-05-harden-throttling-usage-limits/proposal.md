## Why

Both specs validate and both capabilities are shipped, but auditing them against `src/modules/throttling`, `src/modules/usage-limits`, and `src/modules/mcp` found six requirements that read as satisfied and are not. Two are security- or correctness-relevant, and one is a direct contradiction of an explicit requirement.

The pattern is the same one the auth hardening pass found: where a spec states a property the code does not have, the spec retires the question instead of answering it.

## What Changes

**An MCP throttle-storage outage is reported as a rate limit.** `request-throttling` requires that a storage failure "MUST be distinguishable from a genuine rate-limit exceedance", and the Nest path honours that (`503 SERVICE_UNAVAILABLE` versus `429 RATE_LIMITED`). `McpThrottleService.consume` returns the string `'RATE_LIMITED'` on both a real exceedance *and* a Redis outage, so on MCP the two are indistinguishable by construction — an agent told to back off cannot tell whether waiting will help. Fails closed correctly; reports the wrong reason.

**Strict and default throttle policies share one counter and one block key.** `generateKey` returns the bare tracker, so `user:{id}` is the key for both policies, while `handleRequest` swaps in a different ceiling for strict routes. Two consequences: ordinary `/api/v1` traffic consumes the strict allowance (15 default-route requests then one account call = `429` against the strict burst max of 10), and the block key written on a strict violation is policy-agnostic, so exceeding the account ceiling locks the caller out of **every** Nest route for the strict block duration. The spec's "the default burst and per-minute ceilings apply, not the strict account ceilings" is not what happens.

**Usage limits speak a subject type nothing populates.** `CreditService` and `PlanResolutionService` both accept a `BillingSubject` resolved by `BillingSubjectResolver`. `UsageLimitsService` invented a parallel `UsageSubject { userId, orgId? }`, and **no caller ever sets `orgId`** — `UsageLimitsGuard` passes `{ userId }` and so does the MCP path. The org dimension is dead code. Worse, where an org counter would be read, `check()` takes `Math.max(user, org)` and compares it against `ceilingFor(subject)` — the *user's* plan ceiling — so an org-wide limit cannot be expressed at all: the org counter trips at one member's allowance. The spec's claim that the key scheme lets a future model "enforce org-wide ceilings without redesigning keys" is half true; the keys are fine, ceiling *resolution* has no org dimension.

This change makes the org dimension reachable — the guard resolves it through `BillingSubjectResolver` as the credit gate does — and resolves org ceilings from the organization's own plan.

The usage subject keeps two dimensions (the acting member, plus an optional organization represented by `BillingSubject`'s own organization variant) rather than collapsing onto `BillingSubject` outright. That was the original intent here and it does not work: the union's organization variant carries no `userId`, and satisfying it would drop the per-member ceiling that the existing requirement demands, letting one member exhaust an organization's whole quota. Usage genuinely has one more dimension than credits — who acted, as well as who is billed — so it keeps its own subject type, minus the parallel organization representation. See design.md for the correction.

**A rejected consume can leave counters incremented.** `consume` pre-checks every period, then increments in a second loop. When the increment loop hits a ceiling (the race path), it decrements only the offending key — every key and period already incremented in that call stays incremented. So a denied request still spends the caller's daily allowance, and repeated attempts against an exhausted org ceiling inflate the user's own counter with no successful work behind it.

**The effective plan is resolved four times per metered request.** `ceilingFor` calls `PlanResolutionService.resolve`, which runs an uncached `subscription.findMany`. `consume` calls it twice in the pre-check loop and twice more in the increment loop. Plan *matrices* are cached in-process; the subscription lookup is not, and nothing memoizes per request the way `PermissionsGuard` caches its access set.

**A plan-resolution failure escapes the fail-closed path.** `ceilingFor` runs outside `check()`'s `try`, so a database failure during ceiling resolution surfaces as `500 INTERNAL_ERROR` rather than the documented `503 SERVICE_UNAVAILABLE`. It still fails closed, but the response tells the caller the wrong thing.

### Non-goals

- No change to the burst/per-minute window model, the named-throttler arrangement, or the configured defaults.
- No move of `/api/auth/*` under the Nest throttler; that surface stays on Better Auth's own limiter, as the auth hardening pass reaffirmed.
- No change to period boundaries (UTC day, UTC ISO week) or to TTL self-expiry.
- Not introducing org-scoped *throttle* counters — throttling stays keyed on principal or IP. This is about usage ceilings only.
- Not building admin APIs for usage overrides; `admin-monitoring` owns that and is a later change.

## Capabilities

### New Capabilities

None. This change hardens existing capabilities.

### Modified Capabilities

- `request-throttling`: the per-route policy requirement gains the counter-isolation property it implies — a strict ceiling must not be consumed by default-policy traffic, and a block written under one policy must not deny routes governed by another; the storage-failure requirement is restated so distinguishability binds on the MCP path too, not only where an HTTP envelope happens to apply.
- `usage-limits`: the subject becomes a `BillingSubject` with org ceilings resolved from the org's own plan rather than the caller's; a rejected consume is required to leave counters unchanged; ceiling resolution is required to happen once per request and to fail closed with the documented status.

## Impact

**Code**

- `src/modules/throttling/app-throttler.guard.ts` — `generateKey` must distinguish policy so strict and default counters are separate.
- `src/modules/throttling/redis-throttler.storage.ts` — block keys become policy-scoped, so a strict block cannot deny default routes.
- `src/modules/mcp/mcp-throttle.service.ts` — a storage outage must return a distinct reason, not `'RATE_LIMITED'`.
- `src/modules/mcp/agent-pipeline.service.ts` — map that new reason to an MCP error distinct from the rate-limit denial.
- `src/modules/usage-limits/usage-limits.service.ts` — `BillingSubject`, org-aware ceilings, all-or-nothing increments, one ceiling resolution per consume, `ceilingFor` inside the fail-closed boundary.
- `src/modules/usage-limits/usage-limits.guard.ts` — resolve and pass the billing subject, as `CreditsGuard` already does.

**Tests**

- `test/request-throttling.e2e-spec.ts` — strict and default ceilings are independent; a strict block does not deny default routes.
- `test/usage-limits.e2e-spec.ts` — org ceilings from the org plan; a rejected consume leaves counters unchanged; a plan-resolution failure is `503`.
- `test/mcp.e2e-spec.ts` — a throttle-storage outage is distinguishable from a rate-limit denial.

**Auth / billing / credits / throttle**

Throttle and usage only. No credit ledger, plan matrix, or subscription behaviour changes — though `UsageLimitsService` starts consuming `BillingSubjectResolver`, which credits already depend on, so the org-billing feature flag now gates usage ceilings the same way it gates wallets.

**Risk**

Separating strict from default counters *loosens* effective limits for callers who currently trip the shared counter — that is the point, but it means a client previously rejected at a lower combined threshold will now be admitted. Worth stating because it changes observable behaviour under load in a permissive direction, unlike the rest of this change.
