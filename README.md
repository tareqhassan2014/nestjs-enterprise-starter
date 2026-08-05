# NestJS Enterprise Starter

An opinionated NestJS 11 starter with the cross-cutting substrate already built: validated configuration, a uniform API contract, authentication and strict RBAC, structured logging with request correlation, health checks, Prisma + PostgreSQL, Redis, Docker, and CI.

Fork it and build features on top — the parts every service needs are decided and wired.

## 5-minute first run

On a machine with Node 22.12+, pnpm 11+, and Docker:

```bash
cp .env.example .env
pnpm install
pnpm docker:up          # or: make up — app + Postgres + Redis + Mailpit
pnpm db:migrate:deploy  # or: make migrate
pnpm db:seed            # or: make seed — required before authz-heavy flows
curl -s http://localhost:3000/health/ready
```

You should get a Terminus readiness payload (Postgres + Redis healthy). Compose overrides the production image’s secret and mail transport so the placeholder `.env` still boots in containers.

**Seed is not optional** for authorization: the permission catalogue and baseline `user` / `admin` roles come from it.

**Next:** [Configure Google, Apple, Stripe, and Redis](#google-apple-stripe-redis) in `.env.example` / `.env`. OpenAPI UI (when enabled): <http://localhost:3000/docs>. Verification emails: Mailpit at <http://localhost:8025>.

## What's in the box

| Concern | Implementation |
| --- | --- |
| Configuration | Zod schema validated at boot, typed namespaces, `process.env` banned outside `src/config/` by lint |
| API contract | `/api/v1` prefix with URI versioning, uniform success/error envelope, stable error codes |
| Validation | Global `ValidationPipe` — unknown properties rejected, payloads coerced, field-level errors |
| Correlation | `x-request-id` per request via `AsyncLocalStorage`, in every response and log line |
| Logging | Pino — JSON in production, pretty in development, sensitive fields redacted |
| Health | `/health/live` (no dependencies) and `/health/ready` (Postgres + Redis) |
| Persistence | Prisma 7 with the pg driver adapter, versioned migrations, idempotent seed |
| Authentication | Better Auth: email/password with verification, Google + Apple OAuth, database sessions over cookie or bearer |
| Two-factor | TOTP enrolment with encrypted single-use backup codes |
| Authorization | Deny-by-default guards, roles and assignments in the database over a code-declared permission catalogue |
| Abuse resistance | Per-address auth rate limits on Redis, plus self-healing per-account lockout |
| Request throttling | Redis-backed Nest burst + per-minute limits; stricter on account Nest routes |
| Usage limits | Daily/weekly Redis counters per member **and** bound org + feature; each enforced against its own plan's ceiling |
| Plans & subscriptions | Lite / Pro / Enterprise catalogue, monthly/yearly intervals, entitlement gate, seeded limit matrices, org-owned subscriptions |
| Credits & Stripe top-up | User **or** organization wallet + immutable ledger, `@CostsCredits` gate, Checkout Sessions for credit packs |
| Organizations | Create/list orgs, membership with `owner`/`admin`/`member` roles, `X-Organization-Id` binding resolves a `BillingSubject` |
| Job queues | BullMQ (`email`, `webhooks.outbound`, `usage.rollups`, `credits.compensations`) with retries/backoff and a bounded-drain graceful shutdown |
| File storage | `ObjectStorage` port — local-disk adapter for dev, S3 adapter for production (boot fails on an incomplete config) |
| Feature flags | Code-declared catalogue, DB overrides (user → org → global) over env → code defaults |
| Request idempotency | `Idempotency-Key` header + `@Idempotent()`, replay-safe on critical POSTs (org create, checkout, admin credit adjust) |
| Admin monitoring | `/api/v1/admin` usage dashboards, subscription/credit inspection & adjust, audit log, Prometheus `/metrics`, Swagger Admin tags |
| MCP (agents) | Nest-hosted Streamable HTTP MCP at `/mcp` with Bearer API keys; tools map to existing services through RBAC → plan → throttle → usage → credits |
| Transport security | Helmet with an API-appropriate CSP, CORS allowlist, hardened session cookies |
| Mail | Provider-agnostic port with a recording dev adapter and an SMTP adapter; non-critical sends go through the `email` queue |
| Graceful shutdown | Readiness fails fast on `SIGTERM`, BullMQ workers drain within a bounded window, Redis connections force-close past the deadline |
| Local stack | Docker Compose: app + Postgres + Redis + Mailpit, with healthchecks |
| CI | GitHub Actions: lint, typecheck, unit, integration, build, boot smoke test, image build |

Not included by design: Stripe **Subscription** Billing sync (plans stay app-owned), Connect / Tax / Customer Portal, admin SPA / Grafana stack, a real webhook fan-out product (the `webhooks.outbound` queue is a delivery primitive, not a subscriptions UI).

## Requirements

- Node.js 22.12+ — the floor is not arbitrary: `better-auth` is ESM-only and this project compiles to CommonJS, so it is loaded through Node's `require(esm)`, unflagged only from 22.12
- pnpm 11+ (`corepack enable`)
- Docker (for Postgres and Redis)

## Local stack details

The [5-minute first run](#5-minute-first-run) is enough to get healthy. Notes below cover host ports, running the app outside Docker, and hot reload.

Compose supplies a local-only secret and points mail at Mailpit because the `app` service runs `NODE_ENV=production`. Replace that secret anywhere real:

```bash
openssl rand -base64 32
```

If port 5432, 6379, 3000, 1025, or 8025 is already taken on your machine, set the host port in `.env` — only the host side moves, since the app reaches `postgres:5432` on the Compose network regardless:

```bash
POSTGRES_HOST_PORT=5433
REDIS_HOST_PORT=6380
APP_HOST_PORT=3001
MAILPIT_SMTP_HOST_PORT=1026
MAILPIT_UI_HOST_PORT=8026
```

These are read by Docker Compose, not by the application, so they are deliberately absent from `.env.example` and the env schema.

### Running the app outside Docker

```bash
cp .env.example .env
pnpm install
pnpm docker:up postgres redis   # data services only
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm start:dev
```

`prisma generate` is required before the first typecheck or build: the client is generated into `src/generated/` (gitignored), and the build compiles it into `dist/`.

### Hot reload inside Docker

```bash
pnpm docker:up:dev
```

Mounts `src/` into the container and runs `start:dev`.

## Scripts and Make targets

`package.json` scripts are the source of truth. The root `Makefile` wraps the common ones (`make help` lists them).

| Script / Make | Purpose |
| --- | --- |
| `pnpm start:dev` | Watch mode |
| `pnpm build` / `make build` | Compile to `dist/` (SWC, with typecheck) |
| `pnpm typecheck` / `make typecheck` | `tsc --noEmit` across src, tests, and scripts |
| `pnpm lint` / `lint:ci` / `make lint` | ESLint, with and without `--fix` |
| `pnpm test` / `make test` | Unit tests |
| `pnpm test:e2e` / `make test-e2e` | End-to-end and integration tests (needs Postgres + Redis) |
| `pnpm test:smoke` / `make test-smoke` | Boots `dist/main`, checks liveness, asserts clean SIGTERM exit |
| `pnpm check:env` | Fails if `.env.example` and the env schema have drifted |
| `pnpm db:generate` | Generate the Prisma client |
| `pnpm db:migrate` | Create and apply a migration (development) |
| `pnpm db:migrate:deploy` / `make migrate` | Apply pending migrations (CI, production) |
| `pnpm db:seed` / `make seed` | Run the idempotent seed |
| `pnpm db:reset` | Drop, re-migrate, and re-seed |
| `pnpm db:studio` | Prisma Studio |
| `pnpm docker:up` / `:dev` / `docker:down` / `make up` `down` `logs` | Compose stack |
| `make image` | Build the production Docker image (`runner` stage) |
| `make ci-local` | Best-effort local mirror of CI gates |

### Git hooks (Husky)

`pnpm install` runs `prepare` → Husky. Hooks:

- **pre-commit** — `lint-staged` runs ESLint `--fix` on staged `src/`, `test/`, and `scripts/` TypeScript
- **commit-msg** — Conventional Commits via commitlint (`feat:`, `fix:`, `docs:`, …)

Emergency bypass only: `HUSKY=0 git commit …` or `git commit --no-verify`. CI still runs lint, typecheck, tests, and the image build.

### Google, Apple, Stripe, Redis

One sample file: [`.env.example`](.env.example). Annotated sections:

| Integration | Where in `.env.example` |
| --- | --- |
| **Redis** | `REDIS_URL` (near the top, with Postgres) |
| **Google / Apple OAuth** | `GOOGLE_CLIENT_*` / `APPLE_CLIENT_*` under Authentication |
| **Stripe top-up** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CREDIT_PACKS` under Credits & Stripe |

Copy to `.env` and fill the groups you need. Each OAuth/Stripe group is all-or-nothing at boot; Redis is required for the stack to be ready.

## Layout

```
src/
  common/           # applies to every request
    context/        # AsyncLocalStorage request context
    decorators/     # @NoEnvelope()
    errors/         # error codes, ApiException
    filters/        # global exception filter
    http/           # envelope types, health route constants
    interceptors/   # response envelope
    middleware/     # request context
    pipes/          # validation pipe factory
  config/           # env schema + typed namespaces (only place reading process.env)
  infrastructure/   # technical adapters: prisma/, redis/, logger/, health/, mail/
  modules/
    auth/           # Better Auth instance + mount, AuthGuard, account & 2FA endpoints
    authorization/  # permission catalogue, resolver + cache, PermissionsGuard
    …               # your feature modules go here
  generated/        # Prisma client (gitignored)
```

`infrastructure/` holds what could be swapped without touching business logic. `modules/` holds what exists because the product needs it.

## API contract

Every application route lives under `/api/v1`. Health endpoints sit outside it so probe paths survive an API version bump.

**Success** — handlers return their payload; wrapping is global:

```json
{
  "success": true,
  "data": { "id": "1", "name": "Ada" },
  "meta": { "requestId": "0f9c…", "timestamp": "2026-01-01T00:00:00.000Z" }
}
```

**Error** — every failure, from any source:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed.",
    "details": [{ "field": "email", "constraint": "isEmail", "message": "email must be an email" }]
  },
  "meta": { "requestId": "0f9c…", "timestamp": "2026-01-01T00:00:00.000Z" }
}
```

Clients branch on `error.code`, not the HTTP status. Current codes: `VALIDATION_FAILED`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `USAGE_LIMIT_EXCEEDED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`, `EMAIL_NOT_VERIFIED`, `TWO_FACTOR_REQUIRED`, `ACCOUNT_LOCKED`, `ENTITLEMENT_DENIED`, `SUBSCRIPTION_INACTIVE`, `INSUFFICIENT_CREDITS`. Codes are additive — never rename one.

The last three exist because each has a different remedy and a client must be able to tell them apart: verify your address, complete the second factor, or simply wait.

Internal errors never leak: stack traces, SQL, and connection strings are logged with the request ID and replaced by a generic message in the response.

### Correlation IDs

Send `x-request-id` and it comes back on the response and appears in every log line for that request. Send nothing and one is generated. Malformed values (over 64 characters, or outside `[A-Za-z0-9_-]`) are replaced rather than rejected, and are never used for anything but correlation.

### Opting out of the envelope

```ts
@Get('download')
@NoEnvelope()
download() {
  return stream;
}
```

Errors thrown from an exempt handler still use the error envelope. There are two exceptions:

- **Health endpoints** — orchestrators need the Terminus payload even on failure.
- **`/api/auth/*`** — see below. Those routes never reach Nest's interceptor or filter at all.

### `/api/auth/*` does not use the envelope

The authentication routes are served by Better Auth's own router, mounted as Express middleware ahead of Nest's. They therefore receive **neither the global validation pipe, nor the success envelope, nor the exception filter**, and they answer in Better Auth's own shapes with its own error codes:

```jsonc
// POST /api/auth/sign-in/email — success
{ "token": "…", "user": { "id": "…", "email": "…" } }

// POST /api/auth/sign-in/email — failure
{ "message": "Invalid email or password", "code": "INVALID_EMAIL_OR_PASSWORD" }
```

This is a real inconsistency, and it is deliberate: wrapping ~30 library-owned endpoints would mean re-declaring them and re-breaking them on every upgrade. Two rules follow:

- A client must expect **two response shapes on one origin**, split by path prefix. Everything under `/api/v1` uses the envelope; `/api/auth/*` does not.
- The surface sits outside the version segment (`/api/auth`, not `/api/v1/auth`) for the same reason `/health/*` does: the library owns that contract, so it must not move when *our* API version does. A mobile client should not need a new build because the business API went to `v2`.

Our own auth-adjacent endpoints — `/api/v1/account/*` — are ordinary controllers and do use the envelope.

### Third-party webhooks

The global pipe uses `forbidNonWhitelisted`, so a payload carrying fields you do not model is a `400`. That is the right default for a first-party API and the wrong one for Stripe.

**Stripe credit top-up** already ships this pattern: `POST /api/v1/billing/webhook` is served with a raw body (`express.raw`), verifies `Stripe-Signature`, uses `@Public()` + `@NoEnvelope()`, and acknowledges with `{ "received": true }` — **outside** the success envelope (same class of boundary as Better Auth). Invalid signatures are rejected without granting credits.

## Authentication

Better Auth, mounted at `/api/auth/*` and backed by the same Prisma client and Redis as everything else.

| Flow | Endpoint |
| --- | --- |
| Register | `POST /api/auth/sign-up/email` |
| Sign in | `POST /api/auth/sign-in/email` |
| Sign out | `POST /api/auth/sign-out` |
| Verify email | `GET /api/auth/verify-email?token=…` (link is mailed) |
| Request reset | `POST /api/auth/request-password-reset` |
| Complete reset | `POST /api/auth/reset-password` |
| Social sign-in | `POST /api/auth/sign-in/social` (`provider: "google" \| "apple"`) |
| 2FA challenge | `POST /api/auth/two-factor/verify-totp`, `…/verify-backup-code` |

First-party endpoints, inside the envelope:

| Purpose | Endpoint |
| --- | --- |
| Current principal, roles, permissions | `GET /api/v1/account/me` |
| Create / list / revoke agent API keys | `POST\|GET\|DELETE /api/v1/account/api-keys` |
| MCP Streamable HTTP (no envelope) | `POST /mcp` — Bearer API key only |
| Current plan, entitlements, usage ceilings | `GET /api/v1/billing/plan` |
| Credit balance | `GET /api/v1/billing/credits` |
| Recent credit ledger | `GET /api/v1/billing/credits/ledger?limit=20` |
| Start credit pack Checkout | `POST /api/v1/billing/checkout` `{ "pack": "starter" }` |
| Demo paid route (`@CostsCredits`) | `POST /api/v1/billing/demo/paid` |
| Stripe webhook (no envelope) | `POST /api/v1/billing/webhook` |
| Admin usage pressure / top 429s | `GET /api/v1/admin/usage/pressure`, `…/top-429` |
| Admin user usage / subscription / credits | `GET /api/v1/admin/users/:userId/…` |
| Admin credit grant / adjust | `POST /api/v1/admin/users/:userId/credits/grant\|adjust` |
| Admin audit list | `GET /api/v1/admin/audit` |
| Prometheus scrape (no envelope) | `GET /metrics` |
| OpenAPI UI | `GET /docs` (when enabled) |
| List own sessions | `GET /api/v1/account/sessions` |
| Revoke one own session | `DELETE /api/v1/account/sessions/:id` |
| Revoke all but current | `POST /api/v1/account/sessions/revoke-others` |
| 2FA status / enable / verify / disable | `GET|POST /api/v1/account/two-factor…` |
| Re-issue backup codes | `POST /api/v1/account/two-factor/backup-codes` |

### Sessions

Sessions are **rows in Postgres**, cached in Redis. That is what makes revocation immediate: sign out, or revoke a session from another device, and the next request with that token is rejected — there is no signed-cookie window to wait out.

Two transports carry the same session token:

- **Cookie** for browsers — `HttpOnly`, signed, `SameSite=Lax`, `Secure` whenever `APP_URL` is `https`.
- **`Authorization: Bearer <token>`** for mobile and CLI clients.

One session model means one expiry rule and one revocation path. Revoking kills both transports together.

Redis is a cache here and never a source of truth. If it is unavailable, session reads fall through to Postgres and requests keep working — degraded in latency, not in correctness.

### The two postures during a Redis outage

`RedisSecondaryStorage` serves both session caching and the credential rate limiter, and the two must behave in **opposite** ways when Redis is unreachable:

| Operation | Posture | Why |
| --- | --- | --- |
| `get` / `set` / `delete` (sessions) | **Fail open** — error becomes a cache miss | Postgres is authoritative behind them, so a miss falls through and authenticated traffic keeps serving |
| `increment` (limiter counters) | **Fail closed** — error propagates | Nothing is authoritative behind a counter. A missing counter reads as an unused window, so failing open would leave the entire credential surface unmetered during exactly the incident when someone is most likely probing it |

So during a Redis outage: **`/api/auth/*` credential requests are refused with `503`, while already-authenticated requests to `/api/v1/*` keep working.** That is deliberate — it converts a silent degradation into a visible one on the surface that cannot afford to be unmetered. The asymmetry inside a single adapter is load-bearing; collapsing it into one consistent posture reintroduces either an unmetered login surface or a global sign-out.

`increment` also puts the limiter on Better Auth's **atomic** counter path. Without it the library falls back to a non-atomic check-then-write it describes itself as "best-effort", so the configured ceiling would be advisory under concurrency. `createAuth` refuses to boot if the method is missing.

## MCP for agents (Cursor / Claude / ChatGPT)

Nest hosts a **Streamable HTTP** MCP server at `/mcp` (configurable via `MCP_PATH`, default `/mcp`). It sits outside `/api/v1` and outside the success envelope — same boundary class as `/health` and `/metrics`.

**Auth:** `Authorization: Bearer <api_key>` only. Better Auth session cookies are **not** accepted on MCP. Create a key while signed in:

```bash
curl -X POST "$APP_URL/api/v1/account/api-keys" \
  -H "Cookie: app.session_token=…" \
  -H "Content-Type: application/json" \
  -d '{"name":"Cursor laptop"}'
```

The response includes the plaintext secret **once** (`nes_…`). Store it in the client; list/revoke never return it again.

**Tools** are thin adapters over existing services (profile, plan, credits, usage, plus a demo credit-gated tool). Every tool call runs **API key → RBAC → plan → Redis MCP throttle → usage → credits → adapter**. There is no second business layer.

**Non-goals:** session-cookie MCP auth, OAuth dynamic client registration, org-level keys, auto-generating a tool per HTTP route.

### Connect from Cursor

In MCP settings (or `.cursor/mcp.json`), point a remote server at your app:

```json
{
  "mcpServers": {
    "nestjs-starter": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer nes_YOUR_API_KEY"
      }
    }
  }
}
```

### Connect from Claude

Use Claude’s custom MCP / connector configuration with the same Streamable HTTP URL and Bearer header. Prefer the remote HTTP transport (not stdio) against this Nest process.

### Connect from ChatGPT

Add a custom MCP action / connector with base URL `{APP_URL}/mcp` and an Authorization header carrying your API key. Confirm the product’s current remote MCP field names if they differ from `url` + `headers`.

Set `MCP_ENABLED=false` to disable the transport entirely.

### Email verification is required

A new account cannot obtain a session until its address is verified. `MAIL_TRANSPORT=log` prints the link into the application log in development; the Compose stack sends through Mailpit, where you can read it at <http://localhost:8025>.

Following an already-used verification link is a harmless no-op rather than an error — mail clients and link scanners pre-fetch URLs, and showing a real user a failure for a verification that already succeeded is worse than accepting it. Password-reset tokens *are* strictly single-use, because replaying one would set a password twice.

### OAuth providers

Each provider is optional **as a group**. Supply both variables to enable it, neither to disable it. Supplying only one fails at boot, naming what is missing:

```bash
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
```

There is deliberately no `GOOGLE_ENABLED` flag — presence of the credentials *is* the switch, so configuration cannot contradict itself.

## Authorization

Every route requires an authenticated session **unless it says otherwise**. A controller you add today is protected before you think about protecting it.

```ts
@Public()                                  // the only way to open a route
@Get('status')
status() { … }

@RequirePermissions('user:list')           // all listed permissions required
@Get('users')
list() { … }

@RequireRoles('admin')                     // any one listed role suffices
@Delete('users/:id')
remove() { … }

@Get('me')
me(@CurrentUser() user: AuthenticatedPrincipal) { … }
```

`rg '@Public'` is a complete audit of everything reachable without credentials.

### The model: assignments in the database, vocabulary in code

- **`src/modules/authorization/permissions.ts`** declares every permission key. `@RequirePermissions` is typed against it, so `'user:raed'` is a compile error rather than a check that silently never passes.
- **`Role`, `Permission`, `RolePermission`, `UserRole`** hold the assignments. An operator can create roles and grant or revoke them at runtime with no deployment.
- The seed mirrors the code-declared catalogue into `Permission` and asserts the baseline `user` and `admin` roles. A permission row that no declaration names is inert, because no annotation can reference it.

Adding a permission:

```bash
# 1. Append it to PERMISSIONS in src/modules/authorization/permissions.ts
# 2. Grant it to a role in BASELINE_ROLES (admin gets everything automatically)
# 3. Re-seed — upsert-only, so this is safe against a populated database
pnpm db:seed
```

Effective permission sets are cached in Redis and invalidated by **advancing a version counter**, not by deleting keys: one role's mapping can affect thousands of users, and there is no key to enumerate for "everyone holding this role".

**Anything that mutates roles, mappings, or assignments must advance the marker.** In the application, call `PermissionResolver.invalidate()`. From a script or one-off tool — anything with no Nest container — call `advancePermissionVersion(redis)` from `src/modules/authorization/permission-cache-version.ts`. `pnpm db:seed` already does this, and warns rather than fails if Redis is unreachable (a fresh database with no Redis running is normal; there is no cache to invalidate).

If a mutation is applied *without* advancing the marker — editing `role_permissions` directly in the database, for instance — a running instance keeps serving the old grants until its cached entries expire. **The worst case is `PERMISSION_CACHE_TTL_SECONDS` (300 s).** That is the documented staleness bound; it is not a per-request cache, so the window is real.

### The guard chain

```
AuthGuard            → establishes the principal, or 401
PermissionsGuard     → decides whether that principal may proceed, or 403 FORBIDDEN
EntitlementsGuard    → commercial plan gates (@RequireEntitlement / @RequirePlan), or 403 ENTITLEMENT_DENIED
AppThrottlerGuard    → Nest burst / per-minute (Redis), or 429 RATE_LIMITED
UsageLimitsGuard     → optional @UsageLimit, or 429 USAGE_LIMIT_EXCEEDED
CreditsGuard         → optional @CostsCredits, or 402 INSUFFICIENT_CREDITS
```

Order is the contract. Auth and Permissions register in `AuthorizationModule`; plans, throttling, usage, and credits register in modules imported after it in `AppModule` (in that order). Later stages append **after** authorization and must consume the principal `AuthGuard` already resolved rather than re-resolving the session.

A RBAC `403` (`FORBIDDEN`) says only that you were refused. It never enumerates which permissions were required or missing — that would describe the policy to an attacker. Plan denials use `ENTITLEMENT_DENIED` (or `SUBSCRIPTION_INACTIVE` when that classification applies) so clients can show upgrade / renew UI instead of a generic permission error. Insufficient balance uses `402` + `INSUFFICIENT_CREDITS` so clients can prompt a top-up. The full reason is logged with the request id and the user id.

## Plans and subscriptions

Commercial packaging is first-class: **Lite**, **Pro**, and optional **Enterprise**, with subscriptions on **monthly** or **yearly** intervals.

| Piece | Where |
| --- | --- |
| Entitlement vocabulary | `src/modules/plans/entitlements.ts` (code-declared, typed into decorators) |
| Seed matrices | `src/modules/plans/plan-seeds.ts` → `pnpm db:seed` |
| Resolution | `PlanResolutionService` — entitled subscription, else Lite fallback |
| Gate | `@RequireEntitlement(...)` / `@RequirePlan('pro')` after RBAC |
| Current plan API | `GET /api/v1/billing/plan` (authenticated, enveloped) |

**Lifecycle:** `active` and `past_due` are entitled; `canceled` remains entitled only while `currentPeriodEnd` is in the future. Users without an entitled subscription resolve as **Lite** so the starter is not soft-locked.

**Usage ceilings** prefer the effective plan's `plan_usage_limits` row for a catalogue feature; otherwise they fall back to `USAGE_LIMIT_*` env defaults.

Stripe **Subscription** objects do not drive plan status here — Checkout in this starter is for **credit top-up only** (see below). Nullable Stripe id columns on `subscriptions` remain for forks that add Billing sync later.

## Organizations and multi-tenancy

Billing, credits, and plans are resolved against a **`BillingSubject`** — either a user or an organization — not hardcoded to `userId`.

| Piece | Where |
| --- | --- |
| Model | `Organization`, `OrganizationMember` (`owner` / `admin` / `member`), `organizations.billingMode` (`user` or `organization`) |
| Service | `OrganizationsService` — `create`, `listMine`, `addMember`, `removeMember` (role checks; the last `owner` cannot be removed) |
| API | `POST /api/v1/organizations` (idempotent), `GET /api/v1/organizations` (mine), member add/list/remove under `/api/v1/organizations/:organizationId/members` |
| Binding | `X-Organization-Id` header → `OrganizationContextGuard` verifies membership, then publishes `organizationId` on `RequestContext` |
| Billing subject | `BillingSubjectResolver` — no org header → `{ type: 'user' }`; org header + membership + `billingMode: organization` → `{ type: 'organization' }` |

`CreditService` and `PlanResolutionService` both accept a `BillingSubject | string` (the plain string is kept for call sites that only ever dealt in `userId`), so a fork can turn on org billing for a route by resolving and passing a subject — no signature break for the rest of the app. `CreditWallet`, `CreditLedgerEntry`, and `Subscription` all use a DB check constraint enforcing exactly one of `userId` / `organizationId`.

**Not included:** org invitations by email, per-org SSO, transferring ownership between organizations, org-level plan overrides beyond `billingMode`.

## Credits and Stripe top-up

Pay-as-you-go credits sit **after** usage limits in the guard chain.

| Piece | Where |
| --- | --- |
| Cost catalogue | `src/modules/credits/credit-costs.ts` (`CREDIT_COSTS`) |
| Ledger + wallet | `CreditService` — `grant` / `spend` / `refund` / `adjust`, each with an idempotency key, keyed by `BillingSubject` |
| Gate | `@CostsCredits('demo.paid')` — pre-handler spend; compensating refund if the handler throws, retried on `credits.compensations` if that refund itself fails |
| Balance API | `GET /api/v1/billing/credits` (optional `…/ledger`) |
| Demo | `POST /api/v1/billing/demo/paid` |
| Checkout | `POST /api/v1/billing/checkout` with a configured pack slug — requires `Idempotency-Key` |
| Webhook | `POST /api/v1/billing/webhook` — raw body, no success envelope |

**Idempotency:** ledger keys are unique. Guard spends use `spend:{requestId}:{feature}`; Stripe grants use `stripe:checkout:{sessionId}` so webhook retries never double-credit. Pack credit amounts come from **server config**, not from client-supplied metadata alone.

### Required Stripe event subscriptions

Subscribe the webhook endpoint to **both** of these. Credits are granted only when a session's `payment_status` is `paid` or `no_payment_required` — completion alone is not payment:

| Event | Why it is required |
| --- | --- |
| `checkout.session.completed` | Grants immediately for card payments, which settle at completion |
| `checkout.session.async_payment_succeeded` | **Grants for delayed-notification methods** (bank debits, some wallets), which complete a session as `unpaid` and settle later |

**Missing the second subscription means those customers pay and are never credited.** The code path is correct and simply never runs — nothing in the application can detect the missing subscription, so it is worth checking in the Stripe dashboard rather than assuming. Both events derive the same `stripe:checkout:{sessionId}` key, so a session that is already paid at completion is credited once even when both arrive.

A completed-but-unpaid session is acknowledged with `200` and logged at `warn` (`Checkout session has not settled`) — that is a legitimate state, not a delivery failure, and the log is what distinguishes it from an event that never arrived.

**Organization top-up is not supported.** Credits support org-owned wallets and `@CostsCredits` spends from them, but Checkout takes the calling user and grants to *their* wallet — so a member of an org-primary organization spends org credits and can only top up their personal balance. Fund an org wallet through the admin adjust route (`admin:credits:adjust`) until this is built out.

**Stripe config** is optional as a group (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CREDIT_PACKS`). Absent → ledger and `@CostsCredits` still work; Checkout returns `503 SERVICE_UNAVAILABLE`. Prefer a restricted key (`rk_`) in real deployments. Packs are `slug:credits:priceId` comma-separated. API version follows the installed Stripe Node SDK (`2026-07-29.dahlia` for stripe@22).

`CREDITS_LOW_BALANCE_THRESHOLD` emits a `credits.low_balance` event after **any debit** that crosses it — a metered spend or an operator's negative adjust, since either strands the customer. `LowBalanceEmailListener` bridges that event to the `email` queue — behind the `email.low_balance` feature flag or `EMAIL_LOW_BALANCE_ENABLED` — and resolves the recipient from the subject (the user themselves, or the organization's oldest `owner`).

**Not included:** Connect, Tax, Customer Portal, Stripe PaymentIntent refunds as product refunds, or driving subscription `past_due` / cancel from invoices.

## Admin monitoring

Operator HTTP surface under `/api/v1/admin`, gated by typed permissions (not role-only checks):

| Permission | Surface |
| --- | --- |
| `admin:metrics:read` | Usage pressure, top 429s, per-user daily/weekly snapshots |
| `admin:subscriptions:read` | Another user's effective plan / subscription |
| `admin:credits:read` | Another user's wallet + capped ledger |
| `admin:credits:adjust` | Grant / adjust credits (idempotent; requires `reason`) |
| `admin:audit:read` | Append-only admin action audit list |

Baseline `admin` receives every permission; `user` does not. After seeding new keys, run `pnpm db:seed` and call `PermissionResolver.invalidate()` after assignment changes.

**Metrics:** `GET /metrics` is Prometheus text, outside `/api` and outside the success envelope (like health). Enable with `METRICS_ENABLED=true`. Set `METRICS_BEARER_TOKEN` for scrape auth, or isolate the path on the network when the token is blank. Label cardinality stays low — route templates, never user ids.

**OpenAPI:** Swagger UI at `/docs` when `SWAGGER_ENABLED` is true (defaults on in development). Security schemes: `session_token` (cookie), `session_bearer` (Better Auth session), `api_key` (agent keys for `/mcp`). Admin controllers are tagged `Admin`. Documented envelope exceptions: `/api/auth/*`, `/health/*`, `/metrics`, Stripe webhook, MCP.

**Not included:** admin SPA, Grafana/Alertmanager, session impersonation, or Stripe Billing sync from admin actions (ledger adjust is product-side only).

## Two-factor authentication

TOTP, with single-use backup codes.

1. `POST /api/v1/account/two-factor/enable` with the password → returns a provisioning URI and backup codes. **2FA is not active yet.**
2. `POST /api/v1/account/two-factor/verify` with a code from the authenticator → now it is active.

The two-step enrolment is deliberate: activating on step 1 would let a user lock themselves out with a misconfigured app. Enabling rotates the session cookie, so a client must follow the new `Set-Cookie`.

Once active, a correct password yields a **pending challenge**, not a session (`twoFactorRedirect: true`). Complete it with a TOTP code or an unused backup code. Backup codes are stored encrypted under `BETTER_AUTH_SECRET` — the library's default would store them as plaintext JSON, which this starter overrides.

Recovery: `GET /api/v1/account/two-factor` reports how many codes remain, so a user can re-issue before running out. Re-issuing and disabling both require the password, so a stolen session cannot strip the second factor.

## Abuse resistance

Three layers, because they solve different problems.

**Per-address rate limits on `/api/auth/*`** (Better Auth’s Redis limiter), tighter on sign-in, sign-up, reset, and 2FA verification. Counters live in Redis, so limits hold across instances. Boot fails if the credential paths are not configured strictly than the general auth surface, so the guarantee survives edited values.

**Nest burst + per-minute throttling on application routes** (`@nestjs/throttler` on the shared Redis client). Named windows (`burst`, `minute`) apply per **policy** per tracker: authenticated callers key by `user:{id}`, anonymous by IP, and keys carry a `default` / `strict` segment. First-party account / session / 2FA controllers under `/api/v1` use the stricter policy; `/health/*` skips throttling. This limiter does **not** wrap `/api/auth/*` — that surface stays on Better Auth’s rules. Exhaustion returns enveloped `429` with `RATE_LIMITED` and `Retry-After`. Redis failures fail closed as `503 SERVICE_UNAVAILABLE`.

The policy segment matters: counters are **not** shared between the two ceilings. Ordinary `/api/v1` traffic cannot spend the stricter account allowance, and a block written when a caller exceeds the strict ceiling denies only strict-policy routes — not the whole API. Counters remain per policy rather than per route, so exhausting the default burst on one path still protects the other default paths.

**MCP tool invocations** get their own Redis burst + per-minute counters (`MCP_THROTTLE_*`). A genuine exceedance denies with `RATE_LIMITED`; an unreachable counter store denies with `SERVICE_UNAVAILABLE`. Both fail closed — the distinction is so an agent knows whether waiting will help, and so the invocation trail records an outage (`outcome: error`) rather than apparent abuse (`outcome: denied`).

**Daily / weekly usage counters** for declared features (`UsageLimitsService`, optional `@UsageLimit`). Periods are UTC calendar day and ISO week. Exhaustion returns `429` with `USAGE_LIMIT_EXCEEDED` (distinct from burst throttling) plus `Retry-After` until the period resets. Prefer `consume()` after successful billable work when only successes should burn quota.

A usage subject has two dimensions — the acting member, plus an organization when the request is bound to one and that org bills itself (resolved through `BillingSubjectResolver`, same as credits). **Both counters are enforced, each against its own plan's ceiling**: the member's against theirs, the organization's against the organization's. So an org plan can set a genuinely org-wide ceiling, and one member still cannot exhaust it alone. Ceilings come from the effective **plan matrix** when seeded, otherwise from `USAGE_LIMIT_*` env defaults.

A rejected consume leaves every counter as it was — a denied request never spends quota. That is compensation rather than a transaction: increments already applied in the call are rolled back on refusal, and a crash between the two leaves a counter high for the remainder of the period, bounded by its TTL.

**Per-account lockout**, because an address-keyed limiter does nothing about a thousand hosts each making four guesses at one password. After a threshold, retry delay grows exponentially to a cap, and the window **expires on its own** — no sticky lock, and no administrative unlock step. That is intentional: a permanent lock would hand an attacker the ability to deny a real user their own account.

Counters for auth lockout are consumed for addresses that are not registered, and keys hold a hash of the normalised address rather than the address itself, so the limiter can neither be used to enumerate accounts nor leave inboxes lying in the Redis keyspace.

`TRUST_PROXY` is off by default. Turn it on only when the service genuinely sits behind a proxy you control — otherwise any client can forge `X-Forwarded-For` and choose its own rate-limit identity.

Throttle / usage knobs live in `.env.example` (`THROTTLE_*`, `USAGE_LIMIT_*`). `.env.test` uses deliberately generous Nest ceilings so suites that are not about throttling are not blocked; `test/request-throttling.e2e-spec.ts` and `test/usage-limits.e2e-spec.ts` boot with tight overrides and isolated Redis DB indexes.

## Mail

Application code sends through one port, `MailerService`, and never names a provider.

| `MAIL_TRANSPORT` | Behaviour |
| --- | --- |
| `log` | Records the message and logs recipient and subject. **Rejected when `NODE_ENV=production`.** |
| `smtp` | Delivers over SMTP. Requires the whole `SMTP_*` group. |

`log` is refused in production on purpose: it would make sign-up appear to succeed while every verification and reset message silently vanished, leaving accounts nobody can reach. A boot failure is strictly better than unreachable users.

To use a hosted provider, implement `MailerService` in `src/infrastructure/mail/`, bind it in `MailModule`, and change one config value. No authentication code changes.

## Job queues

Auth mail (verification, reset) stays on the **synchronous** `MailerService` path — those failures need to be visible to the caller, not swallowed by a background worker. Everything that is not on the request's critical path goes through BullMQ instead.

| Queue | Purpose | Processor |
| --- | --- | --- |
| `email` | Non-critical mail (e.g. low-balance notices) | `EmailProcessor` → `MailerService.send` |
| `webhooks.outbound` | Outbound webhook delivery | `WebhookProcessor` — `fetch` with a timeout, throws on non-2xx to trigger a BullMQ retry |
| `usage.rollups` | Periodic usage counter housekeeping | `UsageRollupProcessor` — read-only `SCAN` over `usage:*`, does not affect live limit checks |
| `credits.compensations` | Retry a compensating credit refund whose inline attempt failed | `CreditCompensationProcessor` — replays through `CreditService.refund` with the *same* idempotency key, so a refund that actually landed replays as a no-op |

BullMQ gets its **own** `ioredis` connection (`maxRetriesPerRequest: null`), separate from the application's general Redis client, which is deliberately configured to fail fast instead of blocking on retries. Queue name prefix, retry attempts, and backoff come from the `queues` config namespace (`BULLMQ_*` env vars).

**Enqueue services** (`EmailQueueService`, `WebhookQueueService`, `UsageRollupQueueService`) are the only exported surface — application code never touches a `Queue` directly. `UsageRollupQueueService` can also self-schedule on an interval via `USAGE_ROLLUP_INTERVAL_MS` (`0` disables the timer; an admin/cron trigger can still call `enqueueRollup()`).

**Graceful shutdown:** `QueueShutdownService` polls each queue's active job count and returns as soon as it hits zero. If jobs are still running after `SHUTDOWN_DRAIN_MS`, it force-disconnects BullMQ's Redis connection rather than let `@nestjs/bullmq`'s unbounded `worker.close()` hang the process. `/health/ready` fails the instant shutdown starts (before the drain window even begins), so an orchestrator stops routing new traffic while in-flight jobs still have the full window to finish.

## File storage

One port, `ObjectStorage` (`put` / `get` / `delete` / optional `getSignedUrl`), two adapters, selected by `STORAGE_DRIVER`.

| `STORAGE_DRIVER` | Behaviour |
| --- | --- |
| `local` | Writes under a configured root directory. Path traversal outside that root is rejected. **Refused when `NODE_ENV=production`.** |
| `s3` | `@aws-sdk/client-s3` + a presigned-URL helper. Requires the whole `STORAGE_S3_*` group (bucket, region, credentials). |

Same reasoning as `MAIL_TRANSPORT=log` in production: a local adapter silently "succeeding" on ephemeral container disk is worse than a boot failure. Add a new backend by implementing `ObjectStorage` and switching one config value — no call-site changes.

## Feature flags

A small layered override system, not a full flag-management product.

Resolution order (first match wins): **per-user DB override → per-organization DB override → global DB override → env default → code default.** Flags are declared once in `src/modules/feature-flags/feature-flags.catalogue.ts` (`FeatureFlagKey`); passing an undeclared key is a type error at compile time and a rejected call at runtime.

`FeatureFlagsService.setOverride(key, enabled, { userId? , organizationId? })` writes a `FeatureFlagOverride` row; omitting both scopes it globally. Currently used internally by `email.low_balance` (gates the low-balance → email bridge) — `org.billing` is declared for forks that want to stage org billing per-tenant before flipping it everywhere.

## Request idempotency

`@Idempotent()` on a controller method requires an `Idempotency-Key` header and makes retries of that exact request safe.

| Behaviour | Detail |
| --- | --- |
| Missing header | `400` with `IDEMPOTENCY_KEY_REQUIRED` |
| First request | Body is hashed, an `IdempotencyRecord` row is created (`processing`), the handler runs, the response is stored and replayed verbatim on retry |
| Same key, different body | `409` with `IDEMPOTENCY_KEY_REUSE` — the key is a request fingerprint, not just a dedupe token |
| Concurrent duplicate | The unique `(principalId, key)` constraint means the second insert fails fast (Postgres `23505`), rather than the handler running twice |

Applied today to `POST /api/v1/organizations`, `POST /api/v1/billing/checkout`, and `POST /api/v1/admin/users/:userId/credits/adjust`. Records expire after `IDEMPOTENCY_TTL_SECONDS`; add the decorator to any other POST/PUT that must not double-apply on a client retry.

## Knobs you may want, and what they cost

Each of these is a deliberate default. Change them knowingly.

| Knob | Where | Consequence |
| --- | --- | --- |
| `session.cookieCache` | `auth.factory.ts` | Removes the Redis read per request, but hands the session to the client in a signed cookie — **a revoked session keeps working until that cache expires**. Database sessions were chosen for revocability; this trades it back for latency. |
| `sameSite: 'lax'` | `auth.factory.ts` | Required for the OAuth redirect return leg. A browser SPA on a *different registrable domain* needs `'none'` plus `Secure` and a real CORS origin — which also permits cross-site sends. |
| Account linking | Better Auth default | An OAuth sign-in matching an existing **verified** email links to that account. Standard, and usually what you want — but confirm it against your threat model, because it means the provider's verification is trusted. |
| `storeBackupCodes` | `auth.factory.ts` | Set to `'encrypted'`. The library default stores backup codes as plaintext JSON. |
| `TRUST_PROXY` | env | Off by default. On without a real proxy in front means clients pick their own rate-limit identity. |

## Database

The client is generated into `src/generated/prisma` so `nest build` compiles it into `dist/`; the runtime image needs no Prisma CLI. Prisma 7 requires a driver adapter, so the connection string flows from the validated `database` config namespace rather than Prisma reading `process.env` itself.

```bash
pnpm db:migrate --name add_widgets   # create + apply in development
pnpm db:migrate:deploy               # apply pending (CI, production)
pnpm db:seed                         # idempotent; safe to re-run
pnpm db:reset                        # destructive: drop, migrate, seed
```

Migrations never run at application startup — N replicas booting together would race the same migration. Apply them as an explicit deploy step.

**Rolling back a migration already applied to a shared database:**

```bash
# 1. Mark it rolled back so Prisma stops considering it applied
pnpm exec prisma migrate resolve --rolled-back 20260101000000_add_widgets
# 2. Revert the schema change and the migration directory in git
# 3. Create a forward migration that undoes the change
pnpm db:migrate --name revert_widgets
```

Prisma has no automatic down-migrations; forward-only is the supported path.

## Testing

```bash
pnpm test        # unit — no external services
pnpm test:e2e    # e2e + integration — needs Postgres and Redis
```

`.env.test` is committed (it holds no secrets) so tests run on a fresh clone with no setup. Use `.env.test.local` (gitignored) to point at different ports locally.

Integration tests run against real Postgres and Redis, not mocks — that is what makes the health checks, Prisma error mapping, and shutdown behavior meaningful. The auth suites go through the real HTTP surface too: they register, read the verification link out of the recorded mail, sign in, and assert on actual cookies.

`NODE_OPTIONS=--experimental-vm-modules` in the `test*` scripts is **load-bearing, not incidental**. `better-auth` is ESM-only; ts-jest compiles tests to CommonJS; Jest's module registry intercepts the require before Node's `require(esm)` can bridge them. Drop the flag and every auth test fails at import with `SyntaxError: Cannot use import statement outside a module`. `src/modules/auth/better-auth-esm.spec.ts` is the regression guard.

The e2e database must be migrated **and seeded**. Auth rate limits in `.env.test` are deliberately generous, because every suite signs in from the same address and production-shaped limits would throttle tests that have nothing to do with throttling; `test/auth-rate-limiting.e2e-spec.ts` builds its own app with tight limits and its own Redis database.

## Docker

Multi-stage build on `node:22-alpine`: `deps` → `prod-deps` → `build` → `runner`. The runtime image carries production dependencies and `dist/` only — no sources, no dev dependencies, non-root `node` user, `init: true` for signal handling.

Alpine's Node 22 tag resolves well above the 22.12 floor that `require(esm)` needs. The image build is a real gate, not a formality: a package imported for runtime values but only present transitively resolves fine in the dev tree and fails in the production image, which is exactly how `express` — imported for `json()`/`urlencoded()` — had to become a declared dependency.

Alpine is safe here because Prisma 7 ships a WASM query compiler with no native engine binary; the musl/OpenSSL binary-target problem that made Alpine risky under Prisma 6 no longer applies. If you add native dependencies (`bcrypt`, `sharp`), consider switching the base image to `node:22-bookworm-slim`.

## CI

`.github/workflows/ci.yml` runs on push and pull request across a **Node 22 + 24** matrix with Postgres and Redis service containers: install (frozen lockfile) → generate → env drift check → lint → typecheck → unit tests → migrate → **seed** → e2e → build → boot smoke test → production image build (Node 22 cell only). Cheap gates run first. A failing matrix cell fails the workflow.

The boot smoke test exists because path aliases are declared in `tsconfig.json` and mirrored in `.swcrc`; a drift between them passes lint, typecheck, and every test, and fails only when the built output actually runs.

## Conventions

- Read configuration through the typed namespaces in `src/config/`. `process.env` outside that directory is a lint error.
- Handlers return payloads, not envelopes.
- Every query and param DTO carries explicit `class-validator` decorators — implicit conversion coerces types but does not reject them.
- Use `PrismaService`; do not instantiate a second client.
- Seeds use `upsert`, never `create`.
- Routes are protected by default. Open one with `@Public()` and nothing else, so `rg '@Public'` stays a complete audit.
- Prefer `@RequirePermissions` over `@RequireRoles`: a permission says what the route needs, a role says who happens to be allowed today, and only the former survives reorganising the roles.
- Resolve the session once. Guards after `AuthGuard` read the principal it published; they do not call `AuthService` again.
- Call `PermissionResolver.invalidate()` after changing roles, mappings, or assignments.
- Send mail through `MailerService`, never a provider SDK directly.
- New permission keys go in `src/modules/authorization/permissions.ts` first — the database is seeded from it, not the other way round.

## Specs

Planning artifacts live in `openspec/`. Each change's `design.md` records why decisions were made and what was rejected:

- `openspec/changes/archive/…-add-platform-foundation/` — configuration, envelope, logging, persistence, Docker, CI.
- `openspec/changes/add-auth-security/` — authentication, RBAC, 2FA, rate limiting, transport security. Worth reading before changing anything under `src/modules/auth/`: several settings there are non-obvious overrides of library defaults, and the reasoning (with the source verified against) is recorded rather than reconstructed.

## License

MIT.
