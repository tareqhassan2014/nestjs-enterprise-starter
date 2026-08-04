## Why

Auth-route abuse resistance already lives on Better Auth's Redis-backed limiter, but Nest application routes still have no burst or per-minute throttle and no daily/weekly usage quotas. Plans, entitlements, and credits (next) need those counters and a documented place in the guard chain; without them every metered feature will invent its own Redis keys and 429 shape.

## What Changes

- **Consume the existing shared Redis client** for application throttling and usage counters. The `RedisModule`, readiness PING, and fail-fast client settings from the platform foundation stay; this change does not replace them.
- **Global Redis-backed Nest throttler** with named windows: a short **burst** limit and a longer **per-minute** limit, applied to every Nest route by default.
- **Per-route / per-controller throttle policies** via decorators so credential-adjacent first-party routes (account, session, 2FA management under `/api/v1`) are stricter than public or general authenticated routes. Better Auth's `/api/auth/*` limiter remains the authority on that surface; Nest throttling does not try to wrap it.
- **Daily and weekly usage counters** keyed by subject (`user`, and `org` when present), feature identifier, and period. Counters live in Redis with TTL-aligned windows; a reusable service increments and checks so feature modules do not invent their own key schemes.
- **Uniform 429 envelope outcomes**: `RATE_LIMITED` for burst/minute throttling and a distinct `USAGE_LIMIT_EXCEEDED` for quota exhaustion, both with `Retry-After` (and structured `details` where useful) so clients can wait or surface a quota message without parsing prose.
- **Guard-chain slot filled**: after authenticate → authorize (and the reserved entitlements slot), throttle then usage-limit checks run before credits, matching AGENTS.md ordering.

### Non-goals

- **No plan entitlements or billing tiers.** Usage limits ship with configurable defaults and a feature-keyed API; Lite/Pro plan tables and entitlement guards remain a later change that will feed those defaults.
- **No credit ledger or Stripe.** Credits consume usage or sit after these checks; this change does not debit or top up balances.
- **No organizations / multi-tenancy tables.** Counter keys reserve an `org` dimension so a future org model plugs in without a key redesign; no org plugin or tenant tables ship here.
- **No rewrite of auth-surface rate limiting.** Better Auth's per-path limits and account lockout stay as specified in `auth-rate-limiting`. Dual limiters on Nest vs `/api/auth/*` are intentional.
- **No admin UI or admin APIs** to inspect or reset counters. Operators use Redis/config; admin monitoring is a later change.
- **No replacement of Redis connection health.** Liveness/readiness semantics for Redis are unchanged.

## Capabilities

### New Capabilities

- `request-throttling`: Redis-backed global Nest throttling — named burst and per-minute windows, default limits from config, per-route policy overrides, tracking-key rules (IP for anonymous, user when authenticated), coexistence with the auth-surface limiter, and fail-closed vs fail-open behaviour when Redis is unavailable for throttle storage.
- `usage-limits`: Daily and weekly usage counters — subject (`user` / optional `org`) + feature keys, period windows with self-expiring Redis TTLs, check-and-increment API for feature modules, and `429` + `USAGE_LIMIT_EXCEEDED` when a quota is exhausted.

### Modified Capabilities

- `api-response-envelope`: Error-code set gains `USAGE_LIMIT_EXCEEDED` (and documents `RATE_LIMITED` for Nest throttle hits on enveloped routes). Limit responses MUST expose wait/reset timing via `Retry-After` and structured `details` without changing the envelope shape.
- `app-configuration`: Adds validated config for throttle windows/limits (global + named policy presets) and default daily/weekly usage ceilings per feature (or a documented default map).
- `authorization`: Guard-chain documentation updates so request throttling and usage-limit checks occupy the reserved slots after RBAC (and the still-empty entitlements slot) and before credits.

## Impact

**Code**
- New: Nest throttler module wired to the shared `REDIS_CLIENT` (storage adapter), global throttle guard, route policy decorators, usage-limit service/module, and optional usage guard or interceptor for decorated routes.
- Modified: `app.module.ts` / bootstrap guard registration order, `ErrorCode` (+ filter mapping for Nest `ThrottlerException`), `.env.example`, config namespaces, README (throttling + usage section; update "not included" list).
- Tests: unit tests for keying and window maths; e2e for burst/minute 429 + `Retry-After`, per-route stricter policy, usage daily/weekly exhaustion, and Redis-down behaviour for Nest throttling vs auth-surface (already fail-closed).

**APIs**
- Enveloped Nest routes that exceed burst/minute return `429` with `RATE_LIMITED`, `Retry-After`, and existing envelope shape.
- Routes or service calls that exceed daily/weekly usage return `429` with `USAGE_LIMIT_EXCEEDED` and reset timing in headers/`details`.
- No new public CRUD APIs for quotas in this change.

**Dependencies**
- Likely `@nestjs/throttler` (and Redis storage integration compatible with Nest 11 / the shared ioredis client). Exact package choice is a design decision.

**Systems**
- Redis becomes load-bearing for Nest request admission and usage quotas in addition to session cache, auth limiter, and permission cache. Readiness already fails when Redis is down; throttle/usage failure modes must still be explicit so a blip does not silently unmeter the API.

**Auth / billing / credits**
- Auth credential endpoints stay on Better Auth's limiter; Nest account routes get stricter Nest policies.
- Billing/plans will later supply limit numbers; this change owns the mechanism.
- Credits remain after usage checks in the chain and are out of scope here.
