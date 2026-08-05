## Context

Guard chain and commercial stack are complete: Auth → RBAC → Entitlements → Throttle → Usage → Credits (+ Stripe top-up). Permissions already reserve `admin:metrics:read` and `admin:audit:read`, and first-party account controllers explicitly defer cross-user admin HTTP to this change. Operators still inspect Redis/Postgres by hand; there is no OpenAPI, no Prometheus scrape, and no audit trail for privileged mutations.

Constraints: reuse Prisma, Redis, envelope, and existing domain services (`CreditService`, `PlanResolutionService`, `UsageLimitsService`); protect admin business routes with typed `@RequirePermissions`; keep throttle/usage/credit semantics unchanged; secrets only via validated config; metrics/health-class paths stay outside the success envelope.

## Goals / Non-Goals

**Goals:**

- Versioned `/api/v1/admin/*` Nest surface for usage dashboards, billing inspection/adjust, and audit reads.
- Extend permission vocabulary for credits/subscription admin actions; seed onto baseline `admin`.
- Append-only `AdminAuditLog` (name flexible) for privileged admin mutations.
- In-process Prometheus metrics + scrape path.
- OpenAPI/Swagger with **Admin** vs **Public** (and related) tags; document Better Auth / webhook / metrics boundaries.
- Top-429 and RPM-style views without introducing a warehouse.

**Non-Goals:**

- Admin SPA, Grafana stack, org multi-tenancy, session impersonation, Stripe Billing sync, Connect/Tax.
- Replacing Redis throttle/usage stores with analytics DB.
- Enveloping `/metrics` or rewriting `/api/auth/*` into Nest OpenAPI.

## Decisions

### 1. Single `AdminModule` owning `/admin` controllers; domain services stay owners of mutation logic

**Choice:** Add `src/modules/admin/` with controllers:

| Controller (illustrative) | Path prefix | Permissions |
|---------------------------|-------------|-------------|
| Usage dashboard | `admin/usage` | `admin:metrics:read` |
| Billing / credits | `admin/users/:userId/...` | `admin:subscriptions:read`, `admin:credits:read`, `admin:credits:adjust` |
| Audit | `admin/audit` | `admin:audit:read` |

Mutations call `CreditService.grant` / `.adjust` (and existing plan resolution reads). Controllers do **not** write ledger rows directly. After a successful privileged mutation, write an audit row in the same request (prefer: audit write after domain success; if audit write fails, log loudly — do not roll back money-adjacent ledger success that already committed; document the gap).

**Why not** a god `MonitoringModule` that reimplements credits: forks will diverge and skip idempotency. **Why not** role-only `@RequireRoles('admin')`: permission vocabulary already exists so ops can split “metrics reader” vs “credit adjuster” without code changes.

### 2. New permissions (code catalogue + seed)

**Choice:** Keep existing:

- `admin:metrics:read`
- `admin:audit:read`

Add:

- `admin:subscriptions:read` — cross-user effective plan / subscription inspection
- `admin:credits:read` — cross-user wallet + ledger pages
- `admin:credits:adjust` — grant/adjust (implies ability to mutate; reads still need `:read` on GET routes)

Baseline `admin` continues to receive `PERMISSIONS` (all). Do not grant these to `user`.

Optional later (out of scope unless needed for a thin user lookup): reuse `user:read` / `user:list` for resolving user ids rather than inventing `admin:users:*`.

### 3. Usage dashboard reads Redis + small observability side channels

**Choice:**

| View | Source |
|------|--------|
| Daily / weekly usage for a user (and optional feature) | Extend `UsageLimitsService` with admin-safe snapshot APIs over existing keys `usage:{day\|week}:{feature}:u:{userId}` |
| RPM / burst pressure | Aggregate from Prometheus request counters **and/or** sample current throttle keys for a known tracker; primary “RPM” signal is metrics (`http_requests_total` rate). Admin API MAY also return recent per-subject throttle hit counts from a side ZSET (below). |
| Top 429s | On Nest responses that map to `RATE_LIMITED` or `USAGE_LIMIT_EXCEEDED`, increment Redis sorted sets (or hash) keyed by window, e.g. `obs:429:{code}:{yyyyMMddHH}` member = `userId` or `route`, score = count, TTL ~ 48h. Admin API returns `ZREVRANGE` top N. |

Do **not** `KEYS throttle:*` in production paths.

**Why not** Postgres event table for every 429: high write volume and duplicates structured logs. **Why not** only Prometheus for top-N subjects: Prom labels with high-cardinality user ids are an anti-pattern; Redis ZSET keeps cardinality bounded to active offenders per window.

### 4. Audit log model (append-only)

**Choice:** Prisma model roughly:

```
AdminAuditLog
  id, actorUserId, action (string enum-ish),
  targetType, targetId (nullable),
  summary (string), metadata Json?,
  requestId (nullable), createdAt
  @@index([actorUserId, createdAt])
  @@index([action, createdAt])
  @@map("admin_audit_log")
```

Actions at minimum: `credits.grant`, `credits.adjust`, (optional) future role assign if this change wires it — **this change only requires auditing credit mutations it exposes**. Reads are not audited by default (noise); optional later.

No updates/deletes via application API. Admin list endpoint: filter by actor, action, target, time range; cursor or offset with hard max page size.

### 5. Metrics: `prom-client` + `/metrics` outside envelope

**Choice:**

- Dependency: `prom-client` (standard for Node).
- Register default process metrics optionally; always register app metrics: HTTP requests (method, route template, status), 429 by code, credit grant/spend/adjust counts, maybe Stripe webhook outcomes if cheap.
- Scrape path: `GET /metrics` (exclude from global `/api` prefix like health), **not** success-enveloped.
- Auth: **not** session-cookie admin by default. Prefer:
  - Disabled unless `METRICS_ENABLED=true` (or group pattern), **and**
  - Optional `METRICS_BEARER_TOKEN` — when set, require `Authorization: Bearer …`; when unset in private networks, scrape is open (document risk).
- Cardinality: use route **templates** (`/api/v1/admin/users/:userId/credits`), never raw user ids as label values.

**Why not** nestjs-prometheus wrappers alone: fine if they use prom-client underneath; keep one registry. **Why not** put metrics under `/api/v1/admin/metrics` with session auth: scrapers hate cookies; breaks Prometheus pull model.

### 6. OpenAPI / Swagger tags

**Choice:** Add `@nestjs/swagger`, build document in bootstrap (dev and optionally non-prod, or always-on behind config `SWAGGER_ENABLED`).

Tags:

- `Public` — unauthenticated Nest routes (`@Public`)
- `Account` / product tags as useful for first-party user APIs
- `Admin` — every `/admin` controller

Document in README / OpenAPI description:

- `/api/auth/*` — Better Auth, outside Nest contract
- `/health/*` — probes, outside envelope
- Stripe webhook — outside envelope
- `/metrics` — Prometheus text, outside envelope

**Why not** generating OpenAPI for Better Auth: out of scope; link to library docs.

### 7. Admin routes and the commercial guard chain

**Choice:** Admin GET/POST routes:

- Require authentication + admin permissions.
- Do **not** annotate `@CostsCredits` / usage features (operators must not burn credits to inspect).
- Keep Nest throttle (prefer `@StrictThrottle()` on mutation routes).
- Plan entitlements: do not require Pro to be an admin — RBAC alone gates ops.

### 8. Admin credit adjust API shape

**Choice:** Enveloped:

- `GET /api/v1/admin/users/:userId/credits` → balance + recent ledger (capped)
- `POST /api/v1/admin/users/:userId/credits/adjust` body: `{ delta, idempotencyKey, reason }`
- `POST /api/v1/admin/users/:userId/credits/grant` body: `{ amount, idempotencyKey, reason }` (thin wrapper over `CreditService.grant`)

`reason` required for audit summary. Idempotency key required (client- or admin-tool-supplied). Pass metadata including `actorUserId`, `reason` into ledger metadata **and** audit row.

Subscription: `GET /api/v1/admin/users/:userId/subscription` → effective plan + subscription row fields (no other users’ PII beyond what’s needed for support).

### 9. Config

**Choice:** Validated env (illustrative):

| Var | Role |
|-----|------|
| `METRICS_ENABLED` | Expose `/metrics` |
| `METRICS_BEARER_TOKEN` | Optional scrape auth (secret placeholder in `.env.example`) |
| `SWAGGER_ENABLED` | Serve OpenAPI UI (default true in development) |
| `ADMIN_USAGE_TOP_N` | Default top-N for 429 leaderboard (e.g. 20, max capped) |

Use simple booleans rather than over-fitting the “conditionally required group” pattern unless token+enabled need pairing (if enabled + token empty → open scrape is intentional and allowed).

## Risks / Trade-offs

- **[Risk] Audit write fails after successful credit adjust** → Mitigation: structured error log with request id + ledger idempotency key; ops can reconcile; do not silently undo ledger.
- **[Risk] High-cardinality Prometheus labels** → Mitigation: forbid userId/email labels; enforce route templates in interceptor.
- **[Risk] Redis ZSET top-429 undercounts if filter short-circuits before instrumentation** → Mitigation: instrument in exception filter / throttler rejection path once status+code known.
- **[Risk] Open scrape `/metrics` leaks process stats** → Mitigation: default off in production example; document network policy + optional bearer token.
- **[Risk] SCAN-like dashboard queries** → Mitigation: never SCAN for dashboards; only keyed reads + ZSET tops + Prom rates.
- **[Trade-off] RPM is approximate** (Prom rate or window counters) rather than exact billing-grade metering — acceptable for starter ops dashboards.

## Migration Plan

1. Add Prisma `AdminAuditLog` (+ indexes); commit migration.
2. Extend `PERMISSIONS` / descriptions / seed; re-seed environments.
3. Ship metrics module + config (feature-flagged).
4. Ship admin controllers + observability ZSET hooks + audit service.
5. Enable Swagger behind config; update README.
6. Rollback: revert deploy; migration down only if empty/unused — audit rows are append-only historical data (keep by default).

## Open Questions

- Whether role-assign HTTP (`role:assign`) lands in this change or stays DB/seed-only — **default: out of scope**; account controller comment mentioned “roles or sessions” but proposal scopes billing/usage/audit/metrics. Can add a thin `POST /admin/users/:id/roles` later.
- Exact Swagger UI path (`/docs` vs `/api/docs`) — prefer `/docs` excluded from versioned API prefix.
