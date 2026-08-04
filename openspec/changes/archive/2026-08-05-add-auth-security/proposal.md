## Why

The platform foundation deliberately shipped with no notion of a caller: every route is anonymous, `RequestContext` carries only a `requestId`, and the baseline schema has no user. Everything queued behind this change — plan entitlements, usage limits, the credit ledger, Stripe, admin monitoring — is meaningless without an authenticated principal and a way to decide what that principal may do.

Authentication is also the one area where retrofitting is most expensive and most dangerous. Guard ordering, session transport, deny-by-default posture, and where the permission check lives are decisions every later feature encodes against; getting them wrong means either a rewrite or a permission bug. Doing it once, now, before there are any protected resources to migrate, is the cheap moment.

## What Changes

- **Better Auth mounted inside Nest (Express 5).** `betterAuth()` is configured from validated config, backed by the existing `PrismaService` through Better Auth's Prisma adapter, and served by `toNodeHandler` as Express-level middleware at `/api/auth/*` — outside the `/api/v1` version segment, on the same reasoning that keeps `/health/*` outside it: the library owns that route contract, so it must not move when our API version does. Because Better Auth requires the raw request body, Nest is created with `bodyParser: false` and JSON/urlencoded parsing is applied to every path *except* the auth handler's.
- **Email/password with verification and reset.** Sign-up sends a verification link; a session is refused until the address is verified. Password reset is token-based with a bounded lifetime. Password hashing stays on Better Auth's default (scrypt), which needs no native module and so does not reintroduce the musl/glibc question the Alpine base image settled.
- **Google and Apple OAuth.** Both configured as social providers, each independently optional: a fork that only wants Google supplies only Google's credentials, and the provider list is derived from which credential groups are present rather than from a separate feature flag.
- **2FA with TOTP and backup codes.** Better Auth's `twoFactor` plugin, issuer-branded, with single-use backup codes issued at enrolment. When 2FA is enabled for an account, a correct password yields a *pending* 2FA challenge rather than a session.
- **Session strategy: database sessions, two transports.** Sessions are rows in Postgres — revocable, listable, and cached in Redis through Better Auth's `secondaryStorage` so the hot path is not a database read. Browsers get a signed, `HttpOnly`, `SameSite=Lax` cookie; mobile and CLI clients send the same session token as `Authorization: Bearer …` via the `bearer` plugin. One session model, one revocation path, no second token format to keep in sync.
- **Strict RBAC, deny-by-default, database-driven.** New `Role`, `Permission`, `RolePermission`, and `UserRole` tables. Role assignment and role→permission mapping are editable at runtime; the *permission catalogue* is seeded from a canonical list declared in code, so `@RequirePermissions('user:read')` remains a typed union and a decorator can never name a permission that does not exist. A global `AuthGuard` authenticates every route unless marked `@Public()`, and a global `PermissionsGuard` authorizes it. Effective permission sets are resolved once per request and cached in Redis under a per-user version stamp that mutations bump.
- **Authenticated principal in the request context.** `RequestContextStore` gains `userId`, filling the extension point the foundation's design reserved for exactly this. Log lines carry it alongside `requestId`, so a request can be traced to an actor without threading the session through call signatures.
- **Auth-route throttling and account lockout.** Better Auth's built-in rate limiter runs on `secondary-storage` (our Redis client), with tighter per-path rules for sign-in, sign-up, password reset, and 2FA verification than for the rest of the auth surface. Separately, repeated failures against a *single account* trip a per-identifier lockout with exponential backoff and a self-healing window — deliberately not a sticky lock an attacker could use to deny a real user their account. Responses never reveal whether an email is registered.
- **Security headers, CORS, and cookie hardening.** Helmet with a locked-down default policy, an explicit CORS origin allowlist (credentialed requests forbid `*`), Better Auth's `trustedOrigins` derived from the same allowlist so CSRF-origin checks and CORS cannot disagree, and secure cookies enforced whenever the app is not running on plain local HTTP.
- **Transactional email as a port with two adapters.** A `MailerService` interface with a dev/test adapter that logs the message and captures it for assertions, and an SMTP adapter for real delivery. Auth code depends on the port only, so a fork drops in Resend or SES without touching it. A delivery failure is logged and surfaced as a retryable error rather than silently swallowed.
- **BREAKING — routes are authenticated unless marked public.** Deny-by-default is the point: a new controller is protected until someone deliberately opens it, rather than exposed until someone remembers to guard it. `/health/*` and the auth surface are public; the e2e contract fixtures are marked `@Public()` explicitly.
- **Node engine floor raised to `>=22.12`.** `better-auth` is ESM-only with no `require` condition, and this project compiles to CommonJS. `require(esm)` is what bridges them, and it is unflagged only from Node 22.12. Verified against the installed package rather than assumed — see design.

### Non-goals

- **No plan entitlements, credits, or billing.** No plan or subscription model, no Stripe, no entitlement guard. The guard chain is ordered and documented so an entitlement guard slots in after RBAC, but this change ships nothing that reads a plan.
- **No global request throttling.** Rate limiting here covers the auth surface and per-account lockout only. Application-wide throttling and daily/weekly usage limits are a later change that will own `@nestjs/throttler` and the global guard; this change must not pre-empt its storage or key design.
- **No admin APIs for user or role management.** The RBAC tables are runtime-editable and seeded, but the HTTP surface for editing them belongs to the admin-monitoring change. Role changes in this change happen via seed or direct SQL.
- **No organizations, teams, or multi-tenancy.** No `organization` plugin, no tenant scoping on permissions. Roles are global to a user.
- **No JWT/JWKS issuance.** No `jwt` plugin and no stateless verification endpoint. There is no second service to verify tokens yet, and adding one now would mean maintaining a revocation story for tokens nothing consumes.
- **No magic links, passkeys, WebAuthn, phone/SMS, or anonymous sessions.** Each is a Better Auth plugin a fork can add; none is needed to establish the posture.
- **No email templating system.** Verification and reset messages are plain text plus a link. HTML templates are a product concern.
- **No account-linking UX.** Better Auth's default behaviour for an OAuth sign-in matching an existing verified email is accepted as-is; no custom merge flow.

## Capabilities

### New Capabilities

- `authentication`: How a caller proves identity — the mounted Better Auth surface and its routing/body-parsing contract, email/password with mandatory verification, password reset, Google and Apple OAuth with independently optional credentials, database-backed sessions delivered as either a hardened cookie or a bearer token, session revocation, and propagation of the authenticated principal into the request context and logs.
- `two-factor-auth`: TOTP enrolment and verification, the pending-challenge state between a correct password and a session, single-use backup codes, and the recovery and re-issue rules around them.
- `authorization`: Deny-by-default access control — the role and permission model, runtime-editable assignments over a code-declared permission catalogue, the global authenticate-then-authorize guard chain and its documented position relative to later entitlement and credit checks, the route decorators, and permission-cache invalidation.
- `auth-rate-limiting`: Abuse resistance on the credential surface — per-path limits on Redis, per-account lockout with exponential backoff and self-healing windows, uniform responses that leak neither account existence nor lockout state, and the guarantee that a limiter outage fails closed on auth routes without taking the rest of the API down.
- `http-security`: Transport and browser-facing hardening — security response headers, a CORS origin allowlist that forbids wildcard with credentials, cookie attribute rules per environment, and a single source of truth shared between CORS and the framework's CSRF-origin check.
- `transactional-email`: Outbound mail as a provider-agnostic port — the dev/test adapter that captures instead of sending, the SMTP adapter, and how delivery failures surface rather than disappear.

### Modified Capabilities

- `data-persistence`: The **Baseline schema** requirement currently forbids any user, session, or account model. This change supersedes that requirement: the schema now carries Better Auth's models plus the RBAC tables, and the constraint narrows to still forbidding plan, subscription, and credit-ledger models. The seed hook's scope widens to include the permission catalogue and baseline roles, which tightens its idempotency obligation.
- `app-configuration`: Adds a requirement for **conditionally required secret groups**. The existing rule — every secret is mandatory and undefaulted — cannot express an optional OAuth provider whose credentials are all-or-nothing. Validation must reject a half-configured provider while accepting an absent one.
- `api-response-envelope`: The envelope-opt-out requirement names health endpoints as the sole route surface exempt from the *error* envelope. Better Auth's routes are a second: they are handled by Express-level middleware, never reach Nest's filter, and return Better Auth's own error shape. That boundary becomes explicit rather than incidental, and the error-code set gains the codes authorization and lockout need.
- `structured-logging`: Redaction extends to session tokens, TOTP codes, backup codes, OAuth client secrets, and the auth cookie by name. The per-request log context gains the authenticated `userId`, so the correlation requirement now covers actor as well as request.

## Impact

**Code**
- New: `src/modules/auth/` (Better Auth instance, guards, decorators, session service, controllers), `src/modules/authorization/` (permission catalogue, resolver, cache, guards), `src/infrastructure/mail/` (port plus two adapters).
- Modified: `src/main.ts` and `src/bootstrap.ts` (`bodyParser: false`, scoped body parsers, Helmet, CORS, auth handler mount ordering), `src/app.module.ts`, `src/common/context/request-context.ts` (`userId`), `src/infrastructure/logger/logger.options.ts` (redaction, `userId` in `customProps`), `src/config/env.schema.ts` and `.env.example`, `eslint.config.mjs` if the auth module needs a scoped exception.
- Tests: `test/create-test-app.ts` must build the app with the same body-parser and middleware ordering as `main.ts`, or e2e tests will exercise a routing surface the server does not serve. `test/fixtures/contract-fixture.module.ts` routes need `@Public()`.
- `prisma/schema.prisma` gains Better Auth's `User`, `Session`, `Account`, `Verification`, and `TwoFactor` models plus `Role`, `Permission`, `RolePermission`, `UserRole`; one new migration; `prisma/seed.ts` seeds the permission catalogue and baseline roles idempotently.

**APIs**
- **BREAKING**: all Nest routes require an authenticated session unless annotated `@Public()`. Unauthenticated requests get `401 UNAUTHORIZED`; authenticated-but-unpermitted get `403 FORBIDDEN`.
- New surface at `/api/auth/*`, owned by Better Auth: sign-up, sign-in, sign-out, OAuth callbacks, email verification, password reset, and the 2FA endpoints. Responses on these paths use Better Auth's shape, **not** the application envelope.
- New first-party endpoints under `/api/v1` for reading the current principal and managing that user's own sessions and 2FA enrolment — these do use the envelope.

**Dependencies added**
- Runtime: `better-auth`, `helmet`, `nodemailer`
- Dev: `@types/nodemailer`
- `engines.node` tightened to `>=22.12`; Docker and CI already pin Node 22, and must resolve to 22.12 or newer.

**Systems**
- Redis moves from provisioned-but-unused to load-bearing: session cache, auth rate-limit counters, and the permission cache all live there. Its failure modes now have user-visible consequences, which the specs pin down per subsystem rather than leaving to the client library's defaults.
- SMTP becomes an optional external dependency. Absent configuration, the dev adapter is used and no mail leaves the process — which must be impossible to select accidentally in production.
- New required secrets (`BETTER_AUTH_SECRET`, per-provider OAuth credentials, SMTP credentials when SMTP is selected) mean CI and Compose need values; `.env.example` carries placeholders, never real ones.

**Downstream changes** inherit the guard chain, the principal in `RequestContext`, and the permission catalogue from this change. Plan entitlements and credit checks extend the chain after RBAC rather than introducing a parallel guard, and must not re-resolve the session themselves.
