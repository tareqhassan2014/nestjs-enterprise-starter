## Context

The four auth capabilities — `authentication`, `authorization`, `two-factor-auth`, `auth-rate-limiting` — are implemented and their specs validate. The gaps this change closes are not omissions in the specs; they are places where the spec asserts a property the code does not have, which is the failure mode a spec-driven repo is supposed to prevent.

Three of the four gaps trace to a single structural cause worth stating up front: **one Redis adapter is serving two mutually exclusive failure postures.** `RedisSecondaryStorage` is Better Auth's `secondaryStorage`, and Better Auth uses that one object for both session caching and rate-limit counters. Sessions must fail *open* — the archived `add-auth-security` design is explicit that swallowing Redis errors there is correct, because Postgres is authoritative behind it. Limiter counters must fail *closed* — there is nothing authoritative behind them, so an absent counter means "unmetered". The adapter was written for the first requirement and inherited the second by accident.

The mechanism, read out of `better-auth/dist/api/rate-limiter/index.mjs` at the installed version (1.6.25):

```js
consume: ctx.options.secondaryStorage?.increment ? async (key, rule) => { … } : void 0
```

Our adapter has no `increment`, so `consume` is `undefined` and the limiter falls through to `legacyConsume`, whose own doc comment reads: *"Non-atomic check-then-increment … Under concurrency this is best-effort: simultaneous requests can each pass the check before either write lands."* It reads counters through `storage.get(key)` — the method that returns `null` on a Redis error. `decideConsume(null, …)` is a fresh window, so the attempt is admitted. Redis down means the credential surface is unmetered, and the library logs a warning about non-atomicity that nothing in this repo surfaces.

The lockout gap is independent and lives in the interaction between `AccountLockoutService.decide()` and the two Better Auth hooks in `auth.factory.ts`. The permission-cache gap is that `PermissionResolver.invalidate()` has thirteen call sites, all of them in `test/`.

Constraints: no change to session strategy or the guard chain; the Better Auth limiter on `/api/auth/*` stays separate from `request-throttling`'s Nest guard; lockout stays self-healing with no administrative unlock.

## Goals / Non-Goals

**Goals:**

- The credential limiter fails closed on a storage outage, and does so because of how the counter path is built rather than because a comment says so.
- The credential limiter enforces its configured ceiling under concurrency.
- The per-account lockout delay grows as specified, is the caller's true remaining wait, and is demonstrated through HTTP.
- Access-control mutations made outside the running application are observable without waiting out a cache TTL.
- The two spec/implementation divergences (unverified status, backup-code issuance timing) are reconciled in favour of what the code correctly does.

**Non-Goals:**

- Merging the Better Auth limiter with `request-throttling`. They key differently, run at different layers, and the credential surface never reaches a Nest guard. Two mechanisms is the design.
- Replacing `secondaryStorage` with a custom `rateLimit.customStorage`. Considered and rejected below.
- Revisiting the 300 s permission cache TTL, the `cookieCache` decision, or the session fail-open posture.
- Any administrative unlock endpoint.

## Decisions

### Decision 1: Add `increment` to `RedisSecondaryStorage`, with error propagation, rather than a separate limiter storage

`RedisSecondaryStorage` gains:

```
increment(key, ttlSeconds) → number   // INCR, then EXPIRE on first write; errors propagate
```

This one addition fixes both limiter defects at once, and the reason it can is that **`increment` is called only by the rate limiter.** Better Auth's session paths call `get`/`set`/`delete`; nothing else in the library reads `increment` (verified by grep across `dist/`). So the adapter can hold two postures without a conditional: the three session methods keep swallowing their errors and returning a miss, and `increment` propagates. The asymmetry is not an inconsistency to be tidied up later — it is the whole point, and it needs a comment saying so, or someone will "fix" it.

Adding `increment` also moves the limiter off `legacyConsume` onto the atomic `consume` path, which is where the concurrency fix comes from. `INCR` returns the post-increment value; the library compares it to `rule.max` in one round trip. `EXPIRE` is issued only when the counter is created (return value `1`), matching the existing lockout pattern — refreshing the TTL on every attempt would let a persistent attacker hold a window open indefinitely.

*Alternatives considered.*

- **`rateLimit.customStorage`** — a second adapter dedicated to the limiter, cleanly separating the postures by object rather than by method. Rejected because `customStorage` takes precedence over `secondaryStorage` for limiting, so the counters would move off the path the spec's "shared across instances" requirement is currently tested against, and we would own a second storage contract that the library may evolve independently. The `increment` hook is the library's own extension point for exactly this.
- **Wrapping the adapter so `get` throws only when called by the limiter** — requires distinguishing callers by key shape. Fragile, and it makes the fail-closed posture depend on a naming convention in a third-party library.
- **Leaving `legacyConsume` and only fixing fail-open** — would leave the library's own best-effort warning standing on the credential surface. The atomicity fix is free once `increment` exists; declining it would be a choice to keep a known-advisory ceiling on sign-in.

*Note on typing.* `increment` is not in the installed package's exported `SecondaryStorage` type, though the archived `add-auth-security` design records it as an optional member and the runtime reads it. The adapter derives its type as `NonNullable<BetterAuthOptions['secondaryStorage']>`; an extra method on a class implementing that type compiles, but a task verifies this explicitly rather than assuming, because the whole fix depends on the library actually picking the method up. **Confirmed during implementation:** it type-checks as an extra member with no widening, which also means nothing makes the method load-bearing to the compiler — hence the boot-time assertion below.

### Decision 1a: The counters move to their own key namespace *(added during implementation)*

Better Auth keys limiter counters as `<ip>|<path>` (`createRateLimitKey`), with no prefix. Reusing those keys would be a deploy-time outage rather than a migration detail: the `legacyConsume` path this change leaves behind stores a **JSON object** at that key, `INCR` against a JSON string is a Redis error, and a fail-closed counter converts that error into a refused sign-in. Every credential request would `503` until the stale keys aged out — at the default `AUTH_STRICT_RATE_LIMIT_WINDOW_SECONDS` that is five minutes, not a blip.

`increment` therefore writes to `auth:ratelimit:<key>`. Safe precisely because `consume` short-circuits before `get`/`set` are consulted (`onRequestRateLimit` returns in both branches), so the limiter reads and writes counters exclusively through this one method; the old keys are simply never read again. It also gives the counters a greppable namespace alongside `auth:lockout:` and `authz:*`.

### Decision 1b: A limiter outage is answered in the middleware, not left to propagate *(added during implementation)*

The original plan said `increment` should propagate its error and stopped there. Tracing what a client would actually receive showed that "propagate" does not reach the specified response:

- An error raised in the library's `onRequest` — where rate limiting runs — **escapes `handler()` entirely** rather than being converted into a `Response`. Verified in `rate-limit-storage.spec.ts`: the throw surfaces out of `auth.handler()`.
- `BetterAuthMiddleware` passes it to `next()`. Middleware registered via `MiddlewareConsumer` sits outside the Nest pipeline, so `AllExceptionsFilter` never sees it — as that filter's own comment already notes about the library's routes.
- Even if it did reach the filter, `resolveBetterAuthError` deliberately collapses every library `5xx` into `500 INTERNAL_ERROR`.

So the request is refused — fail-closed holds — but presents as an opaque `500`, indistinguishable from a bug. That fails the requirement's "indicates a temporary service condition rather than invalid credentials" scenario, and on a credential endpoint the difference decides whether a client backs off or hammers the dependency that is already down.

`increment` therefore raises `APIError('SERVICE_UNAVAILABLE')` with code `RATE_LIMITER_UNAVAILABLE`, and `BetterAuthMiddleware` answers a Better Auth `APIError` carrying a `5xx` with that status directly. Narrow on purpose: anything else still goes to `next()`, so this cannot swallow a genuine fault. The body uses the library's `{ code, message }` shape rather than the application envelope, because this surface is not enveloped — the same carve-out the `429` requirement already acknowledges.

*Alternative considered:* add a `503` carve-out to `resolveBetterAuthError`. Rejected — the filter is not on this path at all, so the carve-out would be dead code that reads as coverage.

### Decision 1c: Boot fails if the atomic hook is absent *(resolves open question 1)*

`createAuth` asserts `typeof secondaryStorage.increment === 'function'` before constructing the instance — the exact condition the library's ternary tests. Justified by how quiet the failure otherwise is: losing the method turns the ceiling advisory *and* inverts the outage posture, with no error, no failing request, and nothing in a log to notice. Since the method is also invisible to the compiler (see the typing note), a boot-time check is the only thing that makes it load-bearing on our side.

It does not cover a rename on the library's side, which would satisfy the check and still break the wiring. That case is covered behaviourally in `rate-limit-storage.spec.ts`, which drives real requests through a real instance and asserts the library reached for `increment`.

### Decision 2: Lockout state becomes an explicit `(failures, lockedUntil)` pair

Today the Redis value is a bare counter and the lock is implied by `failures >= threshold`, with the unlock time being whatever remains of a fixed `windowSeconds` TTL. Two consequences:

1. **The advertised delay is fiction.** `decide()` computes `min(base × 2^excess, max)` and returns it as `retryAfterSeconds`, but nothing schedules against it — attempts stay refused until the TTL expires. A caller told to wait 2 s and refused at 2 s has been given a wrong answer, and `Retry-After` is mirrored into a standard header by `BetterAuthMiddleware` specifically so clients act on it.
2. **`excess` is always `0`.** Once `failures == threshold`, the `before` hook throws `429`; the `after` hook returns early on `429` without recording. So the counter cannot pass the threshold, and the exponential branch is unreachable through HTTP. The test that "proves" growth calls `recordFailure()` in a loop, bypassing both hooks.

The fix stores both fields and derives the lock from `lockedUntil`:

- `recordFailure` increments `failures`, computes the delay from `failures - threshold`, and stamps `lockedUntil = now + delay` once at or past the threshold.
- `check` reports locked while `now < lockedUntil`, with `retryAfterSeconds = lockedUntil - now` — the true remaining wait.
- The key TTL becomes `max(windowSeconds, remaining delay)` so the record outlives its own lock, and is still set once at creation so self-healing is preserved.

The `after` hook's `429` short-circuit narrows: it must skip only rejections that a limiter or the lock itself produced, and must still count a genuine credential failure — including the one that crosses the threshold. Otherwise escalation stays unreachable for the opposite reason.

The resulting behaviour is the one the spec always described: knocking during a lock does not extend it (no counting on lock-origin `429`), but attempting again *after* the delay elapses does escalate it.

*Alternative considered:* keep the bare counter and simply stop advertising a delay. Rejected — clients need a retry hint, and the spec requires the wait be communicated.

### Decision 3: Permission-cache invalidation becomes a standalone function, not only a service method

`PermissionResolver.invalidate()` needs the Nest container. `prisma/seed.ts` is a standalone script with its own `PrismaClient` and no Redis client, which is why it never calls it — and it is the single most likely thing to change role mappings.

The version key is just a Redis string, so invalidation is extracted to a small module that takes a Redis client and advances `authz:version`, with `PermissionResolver.invalidate()` delegating to it. The seed opens a short-lived Redis connection and calls the same function after `seedAccessControl`. Sharing one implementation matters more than the plumbing: two places computing a version key is how they drift.

The seed must tolerate an unreachable Redis — seeding a fresh database with no Redis running is a normal development state, and there is no cache to invalidate in that case. It logs and continues rather than failing the seed.

The monotonic-timestamp seeding of the version key stays exactly as it is; the reasoning in the existing comment (a counter restarting at zero could resurrect entries written under an earlier version) is unaffected.

*Alternative considered:* have the seed set `authz:version` directly. Rejected — that is the drift this decision exists to prevent.

### Decision 4: Reconcile the two divergences toward the implementation

Both are cases where the code is right and the spec is imprecise:

- **Unverified email** returns `403 EMAIL_NOT_VERIFIED`. `403` is correct — `401` tells a client to discard a session that is in fact valid and re-authenticate, which cannot fix an unverified address. The spec simply never pinned it, while pinning `401` for the sibling case. Spec text changes; no code changes.
- **Backup codes** are returned by `/enable` (step one), not on confirmation. This is also right: a user needs the codes before committing to a second factor. The codes confer nothing while 2FA is inactive, because no challenge is ever raised. Spec text changes; no code changes.

Listing these as spec-only is deliberate. A hardening pass that quietly rewrote working code to match imprecise prose would be the same failure as the drift it is fixing, pointed the other way.

## Risks / Trade-offs

- **Fail-closed converts a Redis outage into sign-in downtime** → This is the specified posture, and the requirement confines it to `/api/auth/*`: authenticated traffic keeps serving from Postgres because the session path still fails open. The alternative is an unmetered credential surface during exactly the incident when an attacker is most likely to be probing. Called out in the proposal because it makes a partial outage visible.
- **The two postures live in one class and look like an inconsistency** → Comment at the asymmetry explaining that `increment` is limiter-only and why the postures must differ, plus a test that asserts both in the same outage. A reviewer who "unifies" them silently reintroduces the fail-open bug.
- **`increment` is undeclared in the installed type surface** → A task verifies the library picks the method up (the limiter must take the `consume` path, not `legacyConsume`) rather than assuming the grep result holds at runtime. A library upgrade that changes the hook name would silently revert both fixes, so the atomic-path assertion is a regression test, not a one-off check.
- **Changing the lockout record shape invalidates in-flight counters** → Keys are TTL-bounded and hold no durable state; the worst case is that locks in force at deploy time are dropped. Not worth a migration.
- **The seed opening a Redis connection adds a failure mode to seeding** → It degrades to a logged warning, and a fresh database with no Redis is treated as the normal case it is.
- **Tightened scenarios may fail on first run against the current code** → Expected, and the point: the scenarios that fail are the ones documenting behaviour the code lacks.

## Migration Plan

No data migration. No schema change. No configuration change — `AUTH_LOCKOUT_*` keeps its four existing variables and their meanings.

Deploy order is unconstrained, but the fail-closed change should land on a deployment whose Redis availability is understood, since it converts a previously-silent degradation into refused sign-ins. Rollback is a revert: removing `increment` returns the limiter to `legacyConsume`, and the lockout record shape is TTL-bounded, so no cleanup is required either way.

## Open Questions

1. ~~Should the non-atomic fallback be made impossible to re-enter — for example, asserting at boot that the limiter resolved an atomic `consume` path — rather than only covered by a test?~~ → **Resolved: yes, split across two mechanisms.** The library's path selection is not observable from outside (`getRateLimitStorage` is not exported), so the boot check asserts the precondition the library tests — that our adapter exposes a callable `increment` — and the behavioural spec covers a library-side rename. See Decision 1c.
2. ~~Should the seed's invalidation failure (Redis unreachable) be surfaced more loudly than a warning?~~ → **Resolved: a warning, plus the bound in the README.** Failing the seed would break the common case it cannot distinguish from the dangerous one — seeding a fresh database with no Redis running is normal, and there is no cache to invalidate then. The warning names the consequence ("a running instance may serve stale role mappings until its cache expires") and `README.md` states the 300 s worst case, so an operator who sees it knows what window they are in.

### Found while running the e2e suite

Three things the tests caught that the plan had wrong. All are recorded because each was a wrong assumption, not a typo.

**A blanket `incr` mock does not isolate the auth limiter.** `RedisThrottlerStorage.increment` also issues `INCR` (on `throttle:*` keys), and the application-wide throttler has its own documented fail-closed `503`. So mocking `redis.incr` globally made every `/api/v1` route `503` too, and the "sessions still serve" assertion failed while proving only that a *different* limiter fails closed. The mock is now scoped to the `auth:ratelimit:` prefix and delegates every other key to the live client — which is a second reason the namespace from Decision 1a earns its place: it makes the two mechanisms separable in tests, not just in the keyspace.

**Revoking email verification is not observed while the session is cached.** Better Auth caches the session *with its user record*, keyed by the bare session token, so flipping `emailVerified` in Postgres is invisible to `getSession` until that entry expires. The test now drops the cache entry to put the guard in front of the authoritative store. Narrow in practice — verification is normally one-way, and Better Auth refusing to issue a session for an unverified address is the primary gate, with `AuthGuard` explicitly the second line — so this is noted rather than treated as a defect of this change. Worth revisiting if a fork ever revokes verification as a moderation action.

**The lockout record's stored shape is asserted by an existing test.** `shares one counter across case variants` read the raw Redis value and expected `'2'`. The `(failures, lockedUntil)` record legitimately changes that, so the assertion now parses the JSON. The test's intent — case variants share one counter — is unchanged.

### On suite stability

The new escalation cases wait out real backoff windows, which is the only way to prove growth survives the request flow. At `baseDelaySeconds: 2` that was roughly 25 seconds of a held Jest worker, and one full run showed four unrelated failures in `usage-limits` (a TTL- and `Retry-After`-sensitive suite) that passed in isolation and could not collide on keys — it isolates to Redis db 11, this suite to db 9. Two runs on the unmodified tree were green, so the likeliest mechanism was back-pressure rather than shared state.

`baseDelaySeconds` is therefore `1` in this suite's config, halving the waits while still yielding 1 → 2 → 4 against a cap of 8. Three consecutive full runs are green (213 tests). Recorded because two clean runs are not proof of absence: if `usage-limits` flakes again, this is the thread to pull, and the fix is to make that suite's timing assertions tolerant rather than to shorten these waits further.

### Residual gap

One scenario in the `authorization` delta has no automated coverage: **"Seed advances the marker."** `advancePermissionVersion` is tested through the production path with a plain client (the mechanism the seed uses), but nothing runs `prisma/seed.ts` itself. Running the real seed inside the e2e suite was rejected deliberately — it rewrites the shared baseline roles that other suites assert on, and `authorization.e2e-spec.ts` already carries a comment about intermittent failures from exactly that kind of shared-state mutation. Verified manually instead — `pnpm db:seed` against the live stack prints `Permission cache invalidated.` Recorded rather than hidden because the scenario rests on that manual step, so nothing would catch a regression here.
