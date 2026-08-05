## Why

Auth, RBAC, plans, throttling, usage limits, and credits are in place, but operators still have no first-party HTTP surface to inspect traffic, quotas, subscriptions, or ledgers — or to adjust credits safely with an audit trail. Without that, forks either poke Redis/Postgres directly or ship ad-hoc admin controllers that skip RBAC, Swagger separation, and Prometheus hooks. This change fills the reserved admin permission slot and the AGENTS.md “admin monitoring” line.

## What Changes

- **Admin API surface**: Versioned `/api/v1/admin/*` controllers gated by existing and extended admin permissions; non-admins get `403` / `FORBIDDEN` without leaking policy.
- **Usage dashboards (read APIs)**: Aggregated views for per-minute / burst pressure (RPM-style), daily and weekly usage counters, and top subjects / routes generating `429` (`RATE_LIMITED` and `USAGE_LIMIT_EXCEEDED`).
- **Subscription + credit inspection / adjust**: Admin read of another user’s effective plan / subscription and credit wallet + ledger; privileged credit `grant` / `adjust` (and optional refund) through `CreditService` with mandatory idempotency and audit.
- **Audit log**: Append-only records for privileged admin mutations (who, what, target, before/after or payload summary, request id, timestamp); admin-readable list/filter API.
- **Metrics hooks**: In-process counters/histograms (HTTP, 429s, credit spends/grants) exposable in a Prometheus text format on a scrape path that is outside the success envelope (health-like boundary).
- **OpenAPI / Swagger**: Document public vs Admin-tagged routes so the starter’s API docs separate operator surfaces from end-user APIs.
- **Permissions**: Consume reserved `admin:metrics:read` / `admin:audit:read`; add billing/ledger admin permissions as needed and seed them onto the baseline `admin` role.

### Non-goals

- **No full admin UI / SPA.** HTTP + OpenAPI only; forks own dashboards.
- **No rewriting throttle, usage, credits, or plan resolution semantics.** Admin surfaces read existing stores/services and call existing mutation APIs with audit wrapping.
- **No org/team multi-tenant admin, row-level “impersonation sessions,” or customer-facing support chat.**
- **No Grafana / Alertmanager / hosted Prometheus stack in-repo.** Exposition hooks and scrape path only.
- **No rewriting Better Auth’s mounted surface into the Admin Swagger tag.** Document the boundary; do not pretend `/api/auth/*` is Nest OpenAPI.
- **No Stripe Billing subscription sync, Connect, Tax, or PaymentIntent refunds** as admin actions — credit adjust is ledger-side only (same product meaning as existing `adjust` / `grant`).
- **No automatic unlock of auth lockouts or permanent ban APIs** beyond what already self-heals via TTL (unless a thin read of lockout state is trivial; prefer leave lockout as-is).
- **No real-time WebSocket admin feed.** Polling REST (+ metrics scrape) is enough for the starter.

## Capabilities

### New Capabilities

- `admin-api`: Admin-only Nest HTTP surface under `/api/v1/admin`, permission-gated; OpenAPI/Swagger tags separating Admin vs public (and documenting non-Nest auth boundary).
- `usage-dashboard`: Admin read APIs for throttle RPM/burst pressure, daily/weekly usage snapshots, and top `429` offenders (subject and/or route).
- `admin-billing`: Admin inspection of another user’s subscription / effective plan and credit wallet/ledger; privileged ledger mutations via existing credit domain API with audit.
- `audit-log`: Append-only admin-action audit store + permission-gated read API.
- `metrics`: Prometheus-ready metric registration and scrape endpoint (outside success envelope), covering request volume, status/`429` outcomes, and credit mutation counters at minimum.

### Modified Capabilities

- `authorization`: Extend the code-declared permission vocabulary for admin billing / ledger adjust (and any other admin resources this change introduces); keep `admin` baseline as “all permissions”; document that admin controllers use `@RequirePermissions` (not role-only) so forks can split ops roles.
- `data-persistence`: Allow an audit-log (and any small supporting) Prisma model(s); seed remains upsert-safe; no speculative analytics warehouses.
- `credits`: Clarify that cross-user ledger read and admin `grant`/`adjust` are admin-API concerns consuming `CreditService` (caller’s self-balance API stays non-admin).
- `subscriptions`: Clarify that cross-user subscription / effective-plan inspection is an admin-API concern (caller’s current-plan read stays non-admin).
- `app-configuration`: Validated config for metrics scrape enablement/path (and any admin dashboard window defaults) via env + `.env.example`.
- `api-response-envelope`: Document the metrics scrape path as outside the success envelope (same class of exception as health / Better Auth / Stripe webhook).

## Impact

**Code**
- New: `admin` module (controllers for usage, billing, audit); `audit` persistence + service; `metrics` module (prom-client or equivalent lightweight registry + controller); OpenAPI bootstrap (`@nestjs/swagger` or project-standard equivalent) with Admin vs public tags.
- Modified: permission catalogue + seed; `AppModule` imports; config schema + `.env.example`; README; optional instrumentation hooks in throttle/usage/credits paths (prefer non-invasive counters).
- Dependencies: OpenAPI/Swagger Nest integration; Prometheus client library if not already present.

**APIs**
- Admin enveloped reads under `/api/v1/admin/...` (usage summary, top 429s, user subscription, user credits/ledger, audit list).
- Admin enveloped mutations for credit grant/adjust (idempotency key required).
- Metrics scrape endpoint (e.g. `/metrics` or configured path) — **not** enveloped; protect via network policy and/or optional shared scrape token as designed (not end-user session by default).

**Auth / billing / credits / throttle**
- All admin business routes remain behind Auth → RBAC (admin permissions). Plan entitlements / throttle / usage / credits gates still apply unless a specific admin route is documented as exempt from commercial metering (prefer: admin reads do not cost credits; admin routes may use strict throttle).
- Credit ledger immutability and idempotency unchanged; admin adjust still appends ledger entries.
- Throttle/usage stores remain Redis; dashboard APIs aggregate/sample rather than requiring a new warehouse.
