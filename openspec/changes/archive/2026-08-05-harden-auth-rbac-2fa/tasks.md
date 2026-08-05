## 1. Credential limiter: atomic counting and fail-closed

- [x] 1.1 Confirm the installed Better Auth still reads `secondaryStorage.increment` to select its atomic `consume` path (`node_modules/better-auth/dist/api/rate-limiter/index.mjs`), and record the version checked in a comment — the whole fix depends on this hook name
- [x] 1.2 Add `increment(key, ttlSeconds): Promise<number>` to `RedisSecondaryStorage`: `INCR`, then `EXPIRE` only when the return value is `1`, so the TTL is set at creation and never refreshed
- [x] 1.3 Let `increment` propagate its errors — no try/catch — while leaving `get`/`set`/`delete` swallowing theirs, and comment the asymmetry: `increment` is limiter-only, sessions must fail open, counters must fail closed
- [x] 1.4 Verify `increment` type-checks against `NonNullable<BetterAuthOptions['secondaryStorage']>` as an extra class member; if the derived type rejects it, widen deliberately at that one site with a note rather than loosening the adapter's type
- [x] 1.5 Assert in a unit spec that the configured limiter resolves an atomic `consume` path rather than `legacyConsume`, so a library rename cannot silently revert both fixes
- [x] 1.6 Resolve open question 1 — decide whether to add a boot-time check in `auth.factory.ts` that the atomic path was selected, and implement it or record why not

## 2. Lockout state becomes `(failures, lockedUntil)`

- [x] 2.1 Change the Redis record in `AccountLockoutService` from a bare counter to `failures` plus `lockedUntil`, keeping the `sha256(normalized identifier)` key scheme unchanged
- [x] 2.2 Rework `recordFailure` to increment `failures`, compute the delay from `failures - threshold`, and stamp `lockedUntil = now + delay` at or past the threshold
- [x] 2.3 Rework `check` to report locked while `now < lockedUntil` and return `retryAfterSeconds = lockedUntil - now`, so the advertised wait is the real one
- [x] 2.4 Set the key TTL to `max(windowSeconds, remaining delay)` at creation only, preserving self-healing with no administrative unlock
- [x] 2.5 Keep `clear` and its swallow-and-warn behaviour, and confirm it clears both fields
- [x] 2.6 Narrow the `after` hook's `429` short-circuit in `auth.factory.ts` so it skips only limiter- and lock-origin rejections, and still records the genuine credential failure that crosses the threshold
- [x] 2.7 Re-check that `retryAfter` on the thrown `APIError` still reaches the client as a standard `Retry-After` via `BetterAuthMiddleware.mirrorRetryAfter`

## 3. Permission-cache invalidation reachable outside the app

- [x] 3.1 Extract advancing `authz:version` into a standalone function taking a Redis client, sharing the existing monotonic-timestamp seeding, and have `PermissionResolver.invalidate()` delegate to it
- [x] 3.2 Call that function from `prisma/seed.ts` after `seedAccessControl`, opening and closing a short-lived Redis connection
- [x] 3.3 Make the seed tolerate an unreachable Redis with a logged warning rather than a failure — a fresh database with no Redis running is a normal development state
- [x] 3.4 Document the worst-case staleness bound (the cache entry lifetime) where an operator would look for it, so it is not inferred from a constant in the source

## 4. Spec-only reconciliations

- [x] 4.1 Confirm `AuthGuard` returns `403` with `EMAIL_NOT_VERIFIED` for a valid session on an unverified account, and that the code is documented wherever error codes are listed — no behaviour change
- [x] 4.2 Confirm `/api/v1/account/two-factor/enable` returns backup codes at enrolment start and that they grant no access while 2FA is inactive — no behaviour change

## 5. Tests

- [x] 5.1 Move the lockout escalation assertion in `test/auth-rate-limiting.e2e-spec.ts` onto the HTTP surface: post credentials, wait out each advertised delay, and assert successive delays increase up to the cap
- [x] 5.2 Add a test that a caller waiting exactly the advertised delay is admitted and evaluated, not refused because a longer window was still in force
- [x] 5.3 Add a test that knocking throughout a lockout window does not extend it — the window ends when it would have ended had the caller stopped
- [x] 5.4 Keep the existing direct-call test as a unit-level check of the decision function, retitled so it no longer reads as covering the end-to-end property
- [x] 5.5 Add a limiter-outage test: with the limiter's storage unreachable, a sign-in is refused rather than admitted unmetered, and the condition is logged with the request identifier
- [x] 5.6 In that same outage, assert an already-authenticated request presenting a valid session is still served from Postgres — the two postures proven together in one test
- [x] 5.7 Add a concurrency test issuing more simultaneous attempts than the strict maximum against one credential path, asserting no more than the maximum are admitted
- [x] 5.8 Add a test in `test/authorization.e2e-spec.ts` that a mapping change followed by the production invalidation path — not the injected service — is observed on the next request
- [x] 5.9 Add an assertion that the unverified-email rejection is `403` with `EMAIL_NOT_VERIFIED`, distinct from the `401` for no session
- [x] 5.10 Add an assertion that backup codes from an unconfirmed enrolment grant no access

## 6. Verification

- [x] 6.1 Run `openspec validate --all` and confirm the four delta specs are clean
- [x] 6.2 Run the full test suite, including the e2e gates, against Postgres and Redis
- [x] 6.3 Re-read the four hardened requirements against the code one final time, and confirm every scenario has something that would fail if the behaviour regressed
- [x] 6.4 Update `README.md` where it describes auth failure postures, if the fail-closed credential surface is not already stated there
