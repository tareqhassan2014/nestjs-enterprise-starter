## Context

Platform foundation shipped a shared `REDIS_CLIENT` (`enableOfflineQueue: false`, readiness PING) and explicitly deferred consumers. Auth security filled three of them — session secondary storage, Better Auth's path limiter, permission-cache version stamps — and reserved Nest's `@nestjs/throttler` for *this* change so auth would not invent a competing key scheme.

Today: Nest routes under `/api/v1` have no burst/minute throttle; daily/weekly quotas do not exist; `RATE_LIMITED` exists for status mapping and auth-adjacent enveloped cases, but there is no `USAGE_LIMIT_EXCEEDED` and no guaranteed `Retry-After` on Nest throttle hits. Guard order in `AuthorizationModule` is Auth → Permissions, with comments reserving entitlements → throttle/limits → credits.

Constraints: reuse the shared Redis client; do not re-wrap `/api/auth/*` (Better Auth never reaches Nest guards); keep envelope shape; honor `TRUST_PROXY` for IP identity the same way auth lockout does; no plan/org tables yet.

## Goals / Non-Goals

**Goals:**

- Global Redis-backed Nest throttling with named **burst** and **per-minute** windows.
- Declarative per-route policies (default vs stricter “auth-adjacent” Nest routes; skip health).
- Daily + weekly usage counters keyed by subject + feature, with org as a reserved key dimension.
- Clear `429` outcomes: `RATE_LIMITED` vs `USAGE_LIMIT_EXCEEDED`, plus `Retry-After` / structured reset details.
- Occupy the documented guard-chain slots after RBAC (entitlements still empty) and before credits.

**Non-Goals:**

- Plan entitlements, Stripe, credits, org tables, admin counter APIs (see proposal).
- Replacing Better Auth rate limits or account lockout.
- Changing Redis readiness/liveness semantics.

## Decisions

### 1. `@nestjs/throttler` + custom storage on `REDIS_CLIENT` — not a hand-rolled middleware

**Choice:** Add `@nestjs/throttler` as the Nest admission control library. Implement (or thin-wrap) a storage backend that uses the existing `REDIS_CLIENT` injection token — same connection as sessions, auth limiter secondary storage, and permission cache.

**Why not** a separate Redis connection: one connection policy, one shutdown path, one readiness story. **Why not** only Better Auth's limiter: it never sees Nest routes. **Why not** pure custom guards without the package: named multi-window limits, `@SkipThrottle`, and `@Throttle` overrides are already the ecosystem contract Nest controllers expect.

**Alternatives considered:** `rate-limiter-flexible` alone (more control, more DIY wiring); per-instance in-memory (wrong for multi-replica Compose/K8s).

### 2. Two named default windows: `burst` and `minute`

**Choice:** Configure Throttler with two named limiters applied globally:

| Name | Typical default (config) | Purpose |
|------|--------------------------|---------|
| `burst` | e.g. 20 / 10s | Spike protection |
| `minute` | e.g. 120 / 60s | Sustained rate |

Both must pass. Values come from validated env (`THROTTLE_BURST_*`, `THROTTLE_MINUTE_*`) so forks tune without code edits. Boot validation rejects non-positive limits.

**Per-route policies** use Throttler's override decorators:

- **Default** — global burst + minute.
- **Strict** — lower ceilings for first-party account/session/2FA management controllers under `/api/v1` (the Nest surface that mutates credentials or sessions, not `/api/auth/*`).
- **Skip** — `@SkipThrottle()` on `/health/*` (and any other probe) so orchestrators are not rate-limited.

“Auth stricter than public” means: anonymous `@Public()` contract fixtures and general authenticated APIs keep the default; account-management Nest controllers opt into **strict**. The Better Auth surface stays on its own stricter Redis rules and is out of Nest's throttle entirely.

### 3. Tracking key: authenticated `userId`, else client IP

**Choice:** Custom `getTracker` (Throttler option / subclassed guard): if `request.user` / request-context `userId` is set, key by `user:{id}`; otherwise `ip:{address}`. IP resolution MUST use the same trust-proxy rules as auth (`TRUST_PROXY` → Express `trust proxy`), so forged `X-Forwarded-For` cannot bypass limits when trust is off.

**Why not** IP-only: shared NAT and mobile carriers punish legitimate users. **Why not** user-only: public routes have no user. Prefixed key namespaces (`throttle:burst:…`, `throttle:minute:…`) avoid colliding with Better Auth / permission / usage keys.

### 4. Throttle Redis failure: fail closed on Nest routes

**Choice:** If Redis errors during a throttle check, reject with `503 SERVICE_UNAVAILABLE` (or `429` only when the limit was actually known to be exceeded — never “allow all”). Readiness already removes the instance when Redis is down; fail-closed prevents a brief window of unmetered traffic if readiness lags.

This matches auth-surface fail-closed posture for abuse-sensitive paths and is acceptable for a template that already requires Redis for ready. Document the difference: session cache fails *open* (Postgres fallback); throttle/usage fail *closed*.

### 5. Usage limits are a separate service, not Throttler windows

**Choice:** Implement `UsageLimitsService` with Redis `INCR` + `EXPIRE` (or SET NX TTL on first hit) for:

```
usage:{period}:{feature}:u:{userId}
usage:{period}:{feature}:o:{orgId}   # reserved; unused until orgs exist
```

Periods: `day` (UTC calendar day or rolling 24h — **pick UTC calendar day** for predictable resets and `Retry-After` at next midnight UTC) and `week` (UTC ISO week). Feature identifiers are a small code-declared catalogue (string union), analogous to permissions — no DB table in this change.

**API surface:**

- `check(subject, feature, period)` — read without increment.
- `consume(subject, feature, periods?)` — atomic check-and-increment for daily and/or weekly; throws `ApiException` with `USAGE_LIMIT_EXCEEDED` when either ceiling is hit.
- Optional `@UsageLimit(feature)` guard/interceptor for routes that should meter every successful attempt; most metering will be explicit `consume()` inside feature services so failed business validation does not burn quota (default: consume only on success paths — document that callers choose).

**Defaults:** config map `USAGE_LIMIT_<FEATURE>_DAILY` / `_WEEKLY` with sensible template defaults; features without config inherit a documented global default. Plan-based overrides are explicitly deferred.

**Org dimension:** `consume` accepts optional `orgId`. When absent, only the user key is touched. When present (future), both user and org keys are enforced (stricter of the two / both must pass — **both must pass** so org-wide abuse and per-user abuse are both capped).

### 6. Error codes and Retry-After

**Choice:**

| Outcome | HTTP | `error.code` | Timing |
|---------|------|--------------|--------|
| Burst/minute exceeded | 429 | `RATE_LIMITED` | `Retry-After` seconds until window reset; `details.limit`, `details.window` optional |
| Daily/weekly exceeded | 429 | `USAGE_LIMIT_EXCEEDED` | `Retry-After` until period end; `details.feature`, `details.period`, `details.limit`, `details.remaining` |
| Throttle store down | 503 | `SERVICE_UNAVAILABLE` | no fake Retry-After required |

Map Nest `ThrottlerException` in `AllExceptionsFilter` (or a thin wrapper guard that throws `ApiException`) so enveloped routes never return Throttler's raw body. Do **not** repurpose `RATE_LIMITED` for quotas — clients need distinct UX (wait a few seconds vs wait until tomorrow / upgrade plan later).

`RATE_LIMITED` already maps from 429 in `errorCodeForStatus`; usage exceptions MUST set `code` explicitly so status→code mapping does not collapse them.

### 7. Guard registration order

**Choice:** Extend `APP_GUARD` providers (or a dedicated throttling/usage module imported after authorization) to:

1. `AuthGuard`
2. `PermissionsGuard`
3. *(reserved)* EntitlementsGuard — not registered yet
4. `ThrottlerGuard` (custom subclass)
5. `UsageLimitsGuard` — only enforces routes/methods annotated with `@UsageLimit`; no-op otherwise

Nest applies `APP_GUARD` in registration order; keep that comment block as the contract. Throttler runs after auth so trackers can use `userId`. Usage after throttle so bursty clients are cut before burning quotas.

### 8. Coexistence with `auth-rate-limiting`

**Choice:** Leave Better Auth limiter + lockout unchanged. Document:

- `/api/auth/*` → Better Auth Redis limiter (path/IP) + lockout (account hash).
- `/api/v1/*` (and other Nest routes) → Nest throttler + optional usage.

No attempt to unify into one library in this change (auth design open question #4 revisited: **keep both**; consolidation is optional later and is config work, not schema).

### 9. Redis module “+ connection health”

**Choice:** No new Redis module. Update the `RedisModule` comment that said throttling would consume it; optionally export a tiny `RedisHealthIndicator` re-export already used by health — no behaviour change. Proposal bullet “Redis module + connection health” is **satisfied by reuse**, called out in README so Group 3 readers do not re-implement it.

## Risks / Trade-offs

**Dual limiters on auth-adjacent Nest routes vs `/api/auth/*`** → Mitigated by documentation and by applying **strict** Nest policy only on first-party account controllers; credential POSTs remain Better Auth’s responsibility.

**Fail-closed Nest throttle makes Redis a hard dependency for all API traffic** → Already true for readiness; residual: a Redis blip returns 503 on Nest routes. Prefer that over unmetered traffic. Session reads still fall back to Postgres.

**UTC calendar windows vs rolling windows** → Calendar is easier to explain and to set `Retry-After`; edge: a user at 23:59 UTC gets a “full” day after one request. Acceptable for a starter; rolling can be a fork knob later.

**Usage consume-on-success requires discipline** → Spec says feature code MUST call `consume` only when the billable unit succeeds (or document opt-in consume-before). Tests for the service itself; e2e covers one decorated example route if we add a fixture.

**Key collision across subsystems** → Mitigated by strict prefixes: `throttle:`, `usage:`, existing Better Auth / `perm:` keys untouched.

**Throttler + multi-window double Redis round-trips per request** → Acceptable at template scale; pipeline if profiling later requires it.

**Org keys unused until multi-tenancy** → Slight API surface for `orgId` that nothing passes yet. Better than renaming keys later.

## Migration Plan

1. Land config + ErrorCode + filter/`ApiException` paths with tests (no behaviour change to existing routes beyond global throttle defaults set high enough for e2e, similar to auth rate limits in `.env.test`).
2. Register global ThrottlerGuard; mark health skip; apply strict to account controllers.
3. Ship `UsageLimitsService` + one e2e fixture feature to prove daily/weekly 429.
4. README: remove “application-wide throttling” from “not included”; document env vars and dual-limiter boundary.
5. Rollback: revert deploy; Redis keys TTL away; no Postgres migration in this change.

E2e: use generous defaults in `.env.test` for suites that hammer the API; dedicated `test/request-throttling.e2e-spec.ts` and `test/usage-limits.e2e-spec.ts` boot with tight limits / isolated Redis DB index (pattern already used by `auth-rate-limiting.e2e-spec.ts`).

## Open Questions

1. **Exact default numeric ceilings** for burst/minute/strict and template usage features — pick conservative starter defaults at apply time; not blocking design.
2. **Whether a demo metered endpoint ships in-tree** (contract fixture) vs service-only until a real feature needs it — prefer a `@Public()` or authenticated fixture route under test modules so e2e is real without polluting product API.
3. **Rolling vs calendar week start** — design picks UTC ISO week; revisit only if product wants timezone-aware resets (out of scope).
