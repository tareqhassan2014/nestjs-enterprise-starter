## 1. Dependencies and configuration

- [x] 1.1 Add `@nestjs/throttler` (version compatible with Nest 11) and any Redis storage helper needed to bind to the shared `REDIS_CLIENT`
- [x] 1.2 Extend `env.schema.ts` with burst/minute/strict throttle variables and usage daily/weekly ceilings; reject non-positive limits at boot
- [x] 1.3 Add typed `throttle` and `usageLimits` config namespaces; wire them in `config/index.ts` / `AppModule`
- [x] 1.4 Update `.env.example` and `.env.test` (generous defaults in test; document purpose comments); ensure CI env-drift check passes
- [x] 1.5 Unit tests: schema rejects `0`/negative throttle maxima; typed namespaces expose coerced numbers

## 2. Error envelope and filter mapping

- [x] 2.1 Add `USAGE_LIMIT_EXCEEDED` to `ErrorCode` without renaming existing codes
- [x] 2.2 Ensure Nest throttle rejections become enveloped `429` + `RATE_LIMITED` with `Retry-After` (filter mapping and/or custom `ThrottlerGuard` throwing `ApiException`)
- [x] 2.3 Ensure usage rejections set `429` + `USAGE_LIMIT_EXCEEDED` with `Retry-After` and structured `details` (feature, period)
- [x] 2.4 Map throttle-store / usage-store Redis failures to `503` + `SERVICE_UNAVAILABLE` (not `RATE_LIMITED` / not `USAGE_LIMIT_EXCEEDED`)
- [x] 2.5 Unit tests: filter/exception mapping for throttle vs usage vs store-down

## 3. Request throttling module

- [x] 3.1 Implement Redis storage adapter on `REDIS_CLIENT` with `throttle:` key prefix; no second Redis connection
- [x] 3.2 Configure global named `burst` and `minute` limiters from config
- [x] 3.3 Subclass/customize `ThrottlerGuard` tracker: `user:{id}` when authenticated, else `ip:{address}` honouring `TRUST_PROXY`
- [x] 3.4 Register throttle guard after `AuthGuard` / `PermissionsGuard` in the documented `APP_GUARD` order; update module comments
- [x] 3.5 Apply `@SkipThrottle()` (or equivalent) on health controllers
- [x] 3.6 Apply strict throttle policy to first-party account/session/2FA Nest controllers under `/api/v1`
- [x] 3.7 Fail closed when Redis errors during a Nest throttle check
- [x] 3.8 Update `RedisModule` comment to note throttling/usage as active consumers (no behaviour change to connection/health)

## 4. Usage limits module

- [x] 4.1 Declare a small code-level feature catalogue (string union) and reject unknown features
- [x] 4.2 Implement `UsageLimitsService` with UTC day / ISO-week keys, TTL, user + optional org dimensions, `check` + `consume`
- [x] 4.3 Implement optional `@UsageLimit(feature)` guard that runs after throttling and uses the resolved principal
- [x] 4.4 Fail closed on Redis errors during consume/check
- [x] 4.5 Unit tests: window maths, TTL, user vs org keys, unknown feature, ceiling enforcement, store-down

## 5. Test fixtures and e2e

- [x] 5.1 Add a test-only metered fixture route (or reuse contract fixture) annotated for usage so e2e can exhaust daily/weekly without a product feature
- [x] 5.2 E2E `request-throttling`: burst and minute `429` + `RATE_LIMITED` + `Retry-After`; strict account policy tighter than default; health not throttled; Nest exhaustion does not apply Better Auth counters; forged `X-Forwarded-For` without trust does not bypass; Redis down → `503`
- [x] 5.3 E2E `usage-limits`: daily and weekly exhaustion → `USAGE_LIMIT_EXCEEDED` + `Retry-After` + details; distinct from throttle code; period rollover / new key after TTL; Redis down → non-quota error
- [x] 5.4 Confirm existing auth-rate-limiting and account e2e suites still pass with generous `.env.test` throttle ceilings

## 6. Documentation

- [x] 6.1 README: document Nest burst/minute throttling, strict account policy, dual-limiter boundary with `/api/auth/*`, usage counters, new env vars; remove application-wide throttling from “not included”
- [x] 6.2 Document guard-chain order including throttle and usage slots (and still-empty entitlements/credits)
