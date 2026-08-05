## Why

The auth capabilities are shipped and their specs all validate, but auditing the four specs against `src/modules/auth` and `src/modules/authorization` turned up requirements that read as satisfied and are not. Three are security-relevant: the credential rate limiter **fails open** when Redis is down (the spec requires fail-closed), it enforces its ceiling **non-atomically** (better-auth itself logs the limit as best-effort), and the exponential lockout backoff is **unreachable through HTTP** — it is only exercised by a test that calls the service directly.

A spec that describes behaviour the code does not have is worse than a thin spec, because it retires the question. This change closes the gaps in code and tightens the requirements so the same drift cannot reappear silently.

## What Changes

**Credential limiter fails closed on a storage outage.** `RedisSecondaryStorage` implements no `increment`, so better-auth's rate limiter falls through to its `legacyConsume` path, which reads counters via `storage.get()`. That adapter deliberately converts a Redis error into `null` — correct for sessions, wrong here: `null` reads as a fresh window, so with Redis down every credential attempt is admitted unmetered. Adding an `increment` method that **propagates** its errors both restores the fail-closed posture and moves the limiter onto its atomic path. One adapter, two postures, split by the fact that only the limiter calls `increment`.

**Credential limiter enforces its ceiling atomically.** The same `increment` addition (Redis `INCR` + `EXPIRE`) replaces check-then-set with a single atomic operation, so concurrent sign-in attempts can no longer each pass the check before either write lands.

**Per-account lockout backoff actually grows.** Once failures reach the threshold the `before` hook throws `429` and the `after` hook skips counting on `429`, so the counter never passes the threshold, `excess` is always `0`, and the advertised delay is pinned at `baseDelaySeconds`. Separately, the reported `retryAfterSeconds` bears no relation to when attempts resume — the real gate is the counter key's fixed `windowSeconds` TTL. Lockout state becomes an explicit `(failures, lockedUntil)` pair so the advertised `Retry-After` is the true wait, and the growth is asserted through the HTTP surface rather than against the service.

**Role and permission mutations are observed without waiting out the cache.** `PermissionResolver.invalidate()` has no production caller — only tests. An operator editing role mappings or re-running the seed gets up to 300 s of stale permissions, while the spec claims a mutation "MUST cause subsequent requests to observe the new state". The change adds an invalidation path reachable outside a test process and pins the staleness bound in the spec.

**Spec/implementation drift is reconciled.** The unverified-email rejection returns `403` but no requirement pins the status, while its sibling scenario pins `401`. Backup codes are issued at `/enable` (step one) though the spec says they are issued on activation (step two).

### Non-goals

- No change to session strategy, transports, cookie attributes, or the `cookieCache` decision.
- No new auth surface, provider, or second factor; TOTP and backup codes stay as they are.
- No change to the guard chain's ordering or to the MCP pipeline's semantics.
- No administrative unlock step — lockout stays self-healing, which is the point of the TTL.
- Not re-litigating the 300 s permission cache TTL; only making mutations observable and the bound explicit.

## Capabilities

### New Capabilities

None. This change hardens existing capabilities rather than introducing behaviour.

### Modified Capabilities

- `auth-rate-limiting`: fail-closed posture becomes a property of the counter path rather than an aspiration — the requirement names atomic increment as the mechanism and forbids a swallowed storage error from reading as an unused window; the backoff requirement is restated so the advertised `Retry-After` must equal the real wait and must be demonstrated end-to-end.
- `authorization`: the versioned-invalidation requirement gains an explicit bound — a mutation applied outside a running instance must be observable via a reachable invalidation path, and the worst-case staleness when that path is not used is stated rather than implied.
- `authentication`: the unverified-email requirement pins its status and error code, matching how the sibling unauthenticated scenario is already pinned.
- `two-factor-auth`: the backup-code issuance requirement is corrected to describe issuance at enrolment start, and states that codes for an unconfirmed enrolment confer no access.

## Impact

**Code**

- `src/modules/auth/redis-secondary-storage.ts` — add `increment`, which propagates errors while `get`/`set`/`delete` keep swallowing theirs. The asymmetry is the design and needs its own comment.
- `src/modules/auth/account-lockout.service.ts` — lockout state becomes `(failures, lockedUntil)`; `check`/`recordFailure` return the true remaining wait.
- `src/modules/auth/auth.factory.ts` — the `after` hook must record the failure that *caused* a lock, so the `429` short-circuit narrows to limiter-origin rejections only.
- `src/modules/authorization/permission-resolver.service.ts` — an invalidation path callable from outside the Nest process.
- `prisma/seed.ts` — invalidate after mutating role mappings.

**Tests**

- `test/auth-rate-limiting.e2e-spec.ts` — the backoff assertion moves onto the HTTP surface; new coverage for a limiter storage outage and for concurrent attempts against one ceiling. The existing direct-call test stays as a unit-level check of the pure decision, but stops standing in for the end-to-end property.
- `test/authorization.e2e-spec.ts` — invalidation through the production path, not the injected service.

**Auth / billing / credits / throttle**

Auth only. No credit, plan, or subscription behaviour changes. Application-wide throttling (`request-throttling`) is untouched — this is the Better Auth limiter on `/api/auth/*`, a separate mechanism, and the two are deliberately not merged.

**Risk**

Fail-closed on the credential surface means a Redis outage stops sign-in. That is the specified posture and the reason the requirement is confined to `/api/auth/*`: authenticated traffic keeps serving from Postgres. Worth stating plainly because it converts a partial outage into a visible one.
