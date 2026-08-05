## Context

`request-throttling` and `usage-limits` are the third and fourth stages of the commercial pipeline (`auth → RBAC → entitlements → throttle → usage → credits`). Both are implemented, both specs validate, and the gaps are places where the spec asserts a property the code does not hold.

Three structural observations frame the decisions below.

**One counter key serves two policies.** `AppThrottlerGuard.generateKey` returns the bare tracker — deliberately, per its comment, so that "exhausting burst on one Nest path protects the rest." But `handleRequest` then substitutes a *different ceiling* for `@StrictThrottle()` routes while leaving the key alone. A shared count compared against two ceilings is not one policy protecting another; it is the stricter ceiling being spent by traffic it was never meant to govern. With the shipped defaults (`burst` 20/10s, `strict.burst` 10/5s) fifteen ordinary requests leave a caller already over the strict ceiling before their first account call.

The block key compounds it. `RedisThrottlerStorage` writes `throttle:{name}:block:{tracker}` and short-circuits on `blockPttl > 0`, returning `totalHits: limit + 1` regardless of which policy is asking. So a strict violation denies every Nest route for the strict block duration — the tighter limit on a sensitive surface becomes a lever for locking the caller out of the whole API.

**Usage limits carry a third subject shape.** `CreditService` and `PlanResolutionService` both accept a `BillingSubject` (`userSubject` / `organizationSubject`), resolved from the request by `BillingSubjectResolver`. `UsageLimitsService` defines its own `UsageSubject { userId, orgId? }`, and no caller sets `orgId` — `UsageLimitsGuard` passes `{ userId: principal.id }` and the MCP path does the same. So the org branch in `keysFor` is unreachable. Where it *would* be reached, `check()` computes `Math.max(user, org)` and compares it to `ceilingFor(subject)`, which resolves the **user's** plan — meaning an organization's aggregate count is measured against one member's allowance, and no org-wide ceiling is expressible however the matrices are configured.

**`consume` is not atomic, and its doc comment says it is.** It pre-checks each period with `MGET`, then increments in a second loop. On the race path — another request took the last slot between check and increment — it decrements only the offending key and throws, leaving every key and period already incremented in that call spent. And `ceilingFor` is called twice in the pre-check loop and twice more in the increment loop, each running an uncached `subscription.findMany`: four identical queries per metered request.

Constraints: no change to window models, period boundaries, TTL self-expiry, configured defaults, or the `/api/auth/*` carve-out. Throttling stays keyed on principal-or-IP; org scoping is a usage-ceiling concern only.

## Goals / Non-Goals

**Goals:**

- Each throttle policy is enforced against its own counter, and a block under one policy does not deny routes under another.
- A throttle-storage outage is distinguishable from a rate-limit exceedance on *every* throttled surface, MCP included.
- Usage limits speak `BillingSubject`, so the org dimension is reachable and org ceilings come from the org's own plan.
- A rejected consume leaves all counters unchanged.
- The effective plan is resolved once per subject per consume, and a ceiling-resolution failure fails closed with the documented status.

**Non-Goals:**

- Org-scoped *throttle* counters. Throttling admission stays principal-or-IP.
- Rewriting `consume` as a Lua script or `MULTI` transaction. Considered below and rejected for this change.
- Any change to how `BillingSubjectResolver` decides a subject, or to the org-billing feature flag's meaning.
- Admin surfaces for inspecting or overriding usage — `admin-monitoring` owns that.

## Decisions

### Decision 1: Policy belongs in the counter key, not only in the ceiling

`generateKey` becomes `{policy}:{tracker}` where policy is `default` or `strict`, and the block key inherits the same scoping. The named throttler (`burst` / `minute`) is already part of the storage key, so the full shape is `throttle:{name}:{policy}:{tracker}`.

This keeps the property the original comment wanted — one counter per policy per tracker, *not* per route, so exhausting burst on one default path still protects the other default paths — while removing the cross-policy bleed. Strict routes get their own burst and minute counters; default routes get theirs.

The block key must be scoped the same way or the fix is cosmetic: a policy-agnostic block reintroduces the whole-API denial through the `blockPttl > 0` short-circuit even with separate hit counters.

*Alternatives considered.*

- **Keep one counter and drop the per-policy ceilings**, relying on the default limit alone. Rejected: the account surface is exactly where a tighter limit earns its keep, and the spec requires the strict policy.
- **Key per route** (the library default `generateKey` includes class and handler). Rejected for the reason the existing comment gives — it fragments limits, so a caller can spend a full burst allowance on each of many routes.
- **Take the minimum of the two ceilings against one counter.** Rejected: it makes every route as strict as the strictest, which is a bigger behaviour change than the bug.

*Consequence worth naming.* This **loosens** effective limits for a caller who currently trips the shared counter — they get a separate strict allowance instead of one drained by default traffic. That is the intended correction, but it is the one permissive change in this set, and it is called out in the proposal for that reason.

### Decision 2: MCP throttle reports storage failure as its own reason

`McpThrottleService.consume` returns `'RATE_LIMITED' | null` and produces `'RATE_LIMITED'` for both a genuine exceedance and a caught Redis error. The return type widens to include a distinct storage-failure reason, and `AgentPipelineService` maps it to an MCP error separate from the rate-limit denial.

Fail-closed behaviour does not change — the tool is still denied and the adapter still does not run. What changes is what the agent is told. The `request-throttling` requirement already demands distinguishability; the Nest path honours it with `503` versus `429`, and MCP silently does not. An agent told "rate limited" backs off and retries a window that will never elapse, and an outage stays hidden behind a routine self-clearing condition.

*Alternative considered:* let the Redis error propagate out of `consume` and handle it in the pipeline. Rejected — `consume`'s contract is "return the denial reason", and a method that returns reasons for one failure class and throws for another is the kind of split that gets one branch missed at the call site.

### Decision 3: Usage keeps two dimensions, expressed with `BillingSubject` for the org half

*Revised during implementation. The original decision said "replace `UsageSubject` with `BillingSubject`", which turned out not to be expressible — see the correction note below.*

`UsageSubject` becomes:

```ts
interface UsageSubject {
  /** The acting member. Their own ceiling always applies. */
  actorUserId: string;
  /** Set when the request is bound to an org that bills itself. */
  billing?: Extract<BillingSubject, { type: 'organization' }>;
}
```

- `keysFor` writes the actor's user key always, and the org key additionally when `billing` is present — which is what makes the existing "exceeding either rejects the consume" requirement mean something.
- `ceilingFor` resolves per key scope: the user key against the actor's effective plan, the org key against the *organization's*. `PlanResolutionService.resolve` already accepts a `BillingSubject` and resolves an organization against its own subscriptions, so no new plan machinery is needed — the org ceiling was always resolvable, it was simply never asked for.
- `UsageLimitsGuard` resolves through `BillingSubjectResolver` exactly as `CreditsGuard` does, and keeps the org subject only when the resolver returns one.

**Why not `BillingSubject` verbatim.** Its organization variant is `{ type: 'organization', organizationId }` — no `userId`. That is right for credits, where `CreditWallet` is XOR-owned by a check constraint and a spend debits exactly one wallet: credits needs one dimension, *who pays*. Usage needs two, *who acted* and *whose quota is consumed*, and the existing requirement already demands both ("exceeding either rejects"). Two independent ceilings are not the double-charge that two wallet debits would be. Collapsing onto `BillingSubject` would have silently dropped the per-member ceiling, letting one member exhaust an entire organization's quota — a behaviour change dressed as a type cleanup.

So usage stays a distinct subject type, and that is now a considered position rather than an accident: it has one more dimension than credits does. What it no longer has is a *parallel representation of the organization* — the org half is `BillingSubject`'s own variant, produced by the resolver, so there is one place that decides what an organization subject is.

*Alternatives considered.*

- **`BillingSubject` verbatim, org-only metering.** One subject shape across credits, plans, and usage. Rejected: removes the per-member ceiling on org-bound requests, contradicting a requirement that exists today.
- **Leave `{ userId, orgId? }` untouched and just populate it.** Fixes both real defects with the smallest diff. Rejected because the org id arrives as a bare string with no resolver-typed provenance, which is how a client-supplied org id eventually gets passed in by mistake.

### Decision 4: All-or-nothing increments via compensation, not a transaction

A rejected consume must leave counters unchanged. Two ways to get there:

The chosen approach keeps the current shape — pre-check, then increment — and makes the failure path roll back **every** key incremented during that call rather than only the offending one. The increment loop accumulates what it has applied; on rejection it decrements all of them.

This is compensation, not atomicity, and the distinction matters: a crash between increment and rollback still leaves counters high. That residual is accepted because the counters are TTL-bounded (they expire with the period), the window is a few milliseconds, and the alternative is worse for this codebase.

*Alternative considered — a Lua script or `MULTI`/`WATCH` doing check-and-increment atomically.* It is the correct answer in the abstract and was rejected on scope: ceilings differ per key scope (user plan versus org plan), so the script would need the resolved ceilings passed in as arguments, and the plan resolution that produces them is a Postgres read that cannot move inside the script. The result would be atomic increments guarded by a ceiling read outside the atomic section — most of the complexity for part of the guarantee. If usage ever needs true atomicity, the ceiling resolution has to be cached or denormalized first; that is a larger change and is recorded here rather than half-done.

Also fixed alongside: `consume`'s doc comment currently claims "Atomically check-and-increment", which was never true. It will describe compensation and name the residual.

### Decision 5: Resolve the effective plan once per subject per consume

`ceilingFor` memoizes per call: a `Map` keyed by subject scope, populated on first use within one `consume`. Four `subscription.findMany` queries per metered request become one per distinct subject scope (one for a user subject, two for an org subject — the org's plan and the member's).

Deliberately *not* a cross-request cache. `PermissionResolver` caches across requests with a version marker precisely because role mappings change rarely and invalidation is cheap to trigger; subscription state changes through Stripe webhooks and admin adjustments, and a stale plan ceiling is a billing-correctness problem. Per-request memoization takes the N+1 off the hot path without introducing an invalidation obligation nobody has signed up for.

`ceilingFor` also moves inside the `try` that reports the fail-closed status, so a Postgres failure during ceiling resolution becomes `503 SERVICE_UNAVAILABLE` rather than `500 INTERNAL_ERROR`. The caller's remedy is the same in both cases, and the distinction is invisible to them.

## Risks / Trade-offs

- **Separating strict and default counters loosens effective limits** → Intended, and the only permissive change here. A caller who previously hit `429` from a shared counter now gets the separate allowance the policies describe. Called out in the proposal because it changes observable behaviour under load.
- **Existing throttle counters are orphaned by the key change** → `throttle:{name}:{tracker}` keys stop being read once the policy segment appears. They are TTL-bounded (window seconds), so they age out; no migration. Unlike the auth limiter's `INCR`-on-JSON hazard, the value format is unchanged, so a stale key cannot cause an error even if it were read.
- **Compensating rollback is not atomic** → Accepted and documented above: TTL-bounded counters, millisecond window, and the atomic alternative needs ceiling caching first. The risk is a slightly inflated counter for the remainder of a period, never a bypassed ceiling.
- **Org subjects double the plan resolutions per consume** → One per distinct scope, memoized within the call. Two queries where an org is bound, one otherwise; previously four regardless. Net improvement even in the org case.
- **`UsageLimitsService` gains a dependency on `BillingSubjectResolver`** → It becomes subject to the org-billing feature flag the same way credits already are, so org ceilings only engage where org billing is enabled. Consistent with credits rather than a new rule, but it does mean usage behaviour now depends on a flag it previously ignored.
- **Tightened scenarios will fail on first run** → Expected; those are the ones documenting behaviour the code lacks.

## Migration Plan

No schema change, no data migration, no configuration change. Throttle counter keys gain a policy segment and old keys age out within one window. Usage keys are unchanged in shape — the org key was already specified and simply never written.

Rollback is a revert. The permissive direction of Decision 1 means a rollback *tightens* limits back to the shared-counter behaviour, which is worth knowing before rolling back under load.

## Correction made during implementation

Decision 3 originally proposed replacing `UsageSubject` with `BillingSubject` outright, and the scoping question put to the user was framed on that basis. Writing it revealed the union's organization variant carries no `userId`, so the "writes both the org key and the calling member's user key" half of that decision was impossible as stated — and satisfying the type would have meant dropping the per-member ceiling, which an existing requirement demands.

Recorded rather than quietly amended because the proposal's "removing a third subject shape" framing was part of why the approach was chosen, and that framing was wrong. The defects being fixed are unchanged: the org dimension was unreachable, and org counts were measured against a member's ceiling.

## Open Questions

1. ~~Should an organization-scoped consume also enforce the calling member's user counter, or only the organization's?~~ → **Resolved: both.** Settled by the correction above — the existing requirement says "exceeding either rejects the consume", and dropping the member ceiling would let one member exhaust an org's quota. The org-only reading would have been a behaviour change, not hardening.
2. ~~Should the new storage-failure reason be recorded distinctly in `McpToolInvocation` so an operator can tell an outage from abuse?~~ → **Resolved during implementation: it already is, for free.** `finish` writes both `outcome` and `errorCode`, and the `outcome` classifier lists `RATE_LIMITED` among the `denied` codes but has no entry for `SERVICE_UNAVAILABLE` — so a storage outage records as `outcome: 'error', errorCode: 'SERVICE_UNAVAILABLE'` against `outcome: 'denied', errorCode: 'RATE_LIMITED'` for a genuine exceedance. Two dimensions already separate them; no `admin-monitoring` change is needed, and none should be made on this account.
