## 1. Schema, permissions, and config

- [x] 1.1 Add Prisma `AdminAuditLog` (actor, action, target type/id, summary, metadata, requestId, createdAt; indexes; snake_case `@@map`); generate and commit migration
- [x] 1.2 Extend `PERMISSIONS` / descriptions with `admin:subscriptions:read`, `admin:credits:read`, `admin:credits:adjust` (keep existing `admin:metrics:read` / `admin:audit:read`); confirm baseline `admin` still receives all permissions and `user` does not
- [x] 1.3 Add validated config for `METRICS_ENABLED`, optional `METRICS_BEARER_TOKEN`, `SWAGGER_ENABLED`, and `ADMIN_USAGE_TOP_N` (or equivalents); update `.env.example` with placeholders only
- [x] 1.4 Add dependencies: `@nestjs/swagger`, `prom-client` (and swagger peer deps as required)

## 2. Metrics module

- [x] 2.1 Implement metrics registry provider with HTTP, 429-by-code, and credit-mutation counters; forbid high-cardinality user labels
- [x] 2.2 Expose `GET /metrics` outside `/api` prefix and success envelope; honor enable flag and optional bearer token
- [x] 2.3 Instrument request completion and known `RATE_LIMITED` / `USAGE_LIMIT_EXCEEDED` paths; hook credit mutation counters from `CreditService` (or thin wrapper events)
- [x] 2.4 Unit/e2e: enabled scrape returns Prometheus text; disabled → no series; bearer required when configured

## 3. Audit log service

- [x] 3.1 Implement `AuditLogService` append-only write + paginated filtered list (action, actor, target, time range; hard max page size)
- [x] 3.2 Unit tests: write/list/filter; no update/delete API surface

## 4. Usage observability and dashboard APIs

- [x] 4.1 Add Redis ZSET (or equivalent) side channel incremented on `RATE_LIMITED` / `USAGE_LIMIT_EXCEEDED` with TTL; top-N read helper capped by config
- [x] 4.2 Extend `UsageLimitsService` (or admin adapter) for admin snapshots of daily/weekly usage by user + catalogue feature(s)
- [x] 4.3 Implement admin usage controllers under `/api/v1/admin/usage` gated by `admin:metrics:read` (snapshots, RPM/pressure summary from metrics, top 429s)
- [x] 4.4 Tests: permission denial; snapshot for known feature; top-N ordering; no `KEYS`/`SCAN` of full throttle keyspace on the happy path

## 5. Admin billing APIs

- [x] 5.1 Implement `GET /api/v1/admin/users/:userId/subscription` with `admin:subscriptions:read` using `PlanResolutionService`
- [x] 5.2 Implement `GET /api/v1/admin/users/:userId/credits` with `admin:credits:read` (balance + capped ledger page)
- [x] 5.3 Implement grant/adjust POSTs with `admin:credits:adjust`, required reason + idempotency key, delegating to `CreditService`; write audit on success
- [x] 5.4 Tests: RBAC matrix (read vs adjust); grant/adjust ledger + audit; idempotent replay; validation without reason; `404` unknown user

## 6. Admin audit API and module wiring

- [x] 6.1 Implement `GET /api/v1/admin/audit` with `admin:audit:read` (filters + pagination)
- [x] 6.2 Wire `AdminModule` into `AppModule`; apply `@StrictThrottle()` on mutation routes; ensure admin routes are not `@CostsCredits` / usage-metered
- [x] 6.3 E2E: non-admin → `403` on admin routes; admin with permissions → `200` envelope

## 7. OpenAPI / Swagger

- [x] 7.1 Bootstrap OpenAPI document with `Admin` tag on admin controllers and sensible tags on public/account routes; serve UI behind `SWAGGER_ENABLED`
- [x] 7.2 Document envelope exceptions for `/api/auth/*`, `/health/*`, `/metrics` (and Stripe webhook if not already) in OpenAPI description and/or README

## 8. Regression and docs

- [x] 8.1 E2E: admin adjust then self-balance reflects change; usage-limit / throttle e2e suites still pass; credit idempotency unchanged
- [x] 8.2 README: admin permissions, `/api/v1/admin` surfaces, audit log, metrics scrape + network/token guidance, Swagger tags, non-goals (no admin SPA / Grafana)
