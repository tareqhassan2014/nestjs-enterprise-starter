## 1. Dependencies and the ESM/CommonJS bridge

- [x] 1.1 Add runtime dependencies: `better-auth`, `helmet`, `nodemailer`; dev dependency `@types/nodemailer`
- [x] 1.2 Raise `engines.node` from `>=22` to `>=22.12` — `require(esm)` is unflagged only from 22.12, and it is what lets a CommonJS build load the ESM-only `better-auth`; confirm the Docker base image and CI runner both resolve to 22.12 or newer
- [x] 1.3 Verify `require('better-auth')`, `better-auth/node`, `better-auth/adapters/prisma`, `better-auth/plugins/two-factor`, and `better-auth/plugins/bearer` all resolve from a plain CommonJS `node -e` before writing anything on top of them (design decision 1)
- [x] 1.4 Add `NODE_OPTIONS=--experimental-vm-modules` to `test:debug`, which currently lacks it, and add a comment at each of the three scripts recording that the flag is load-bearing for loading the ESM-only auth dependency — without it, ts-jest-compiled tests fail with `SyntaxError: Cannot use import statement outside a module`
- [x] 1.5 Add a throwaway spec that imports `betterAuth` and asserts it is callable; confirm it passes under `pnpm test` and fails under a bare `jest` invocation, then keep it as the regression guard for the flag
- [x] 1.6 Confirm `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and `pnpm build` still pass with the dependencies added but nothing wired

## 2. Configuration and the environment contract

- [x] 2.1 Add to `src/config/env.schema.ts`: `BETTER_AUTH_SECRET` (required, min 32 chars, no default), `APP_URL` (used to build verification and reset links and OAuth callbacks), `SESSION_EXPIRES_IN_SECONDS`, `SESSION_UPDATE_AGE_SECONDS`
- [x] 2.2 Add OAuth credential groups as conditionally required: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `APPLE_CLIENT_ID`/`APPLE_CLIENT_SECRET`, via `superRefine` — absent as a whole group is valid, partially present fails naming the missing member and its group, and no member carries a default
- [x] 2.3 Derive the enabled-provider list from which groups are present; add no `*_ENABLED` flag that could contradict the credentials
- [x] 2.4 Add `CORS_ORIGINS` (comma-separated) with per-value origin validation, and reject a wildcard value at boot since credentialed CORS is in effect
- [x] 2.5 Add `TRUST_PROXY` (default off) — it drives Express's `trust proxy` and Better Auth's `advanced.ipAddress.ipAddressHeaders` from one value, so client-IP resolution has a single answer
- [x] 2.6 Add `MAIL_TRANSPORT` (`log` | `smtp`), `MAIL_FROM`, and the SMTP group (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`) required as a group only when `MAIL_TRANSPORT=smtp`
- [x] 2.7 Reject `MAIL_TRANSPORT=log` when `NODE_ENV=production`, with an error explaining that a delivering transport is required — a silent transport in production means unreachable accounts while sign-up appears to succeed
- [x] 2.8 Add auth rate-limit and lockout settings: window and max for the general auth surface and for the strict credential paths, plus lockout threshold, base delay, delay cap, and window
- [x] 2.9 Add `auth`, `security`, and `mail` config namespaces exporting their `ConfigType`, deriving from the validated env like the existing namespaces
- [x] 2.10 Update `.env.example` with every new variable, a purpose comment per line, Compose-compatible non-secret defaults, and placeholders (never real values) for secrets; confirm `pnpm check:env` passes
- [x] 2.11 Tests: complete env passes; missing `BETTER_AUTH_SECRET` fails; a 20-character secret fails naming the length constraint; Google ID without secret fails naming the missing variable and group; both provider groups half-configured are reported in one aggregated error; absent Apple group passes and leaves Apple disabled; `CORS_ORIGINS=*` fails; `MAIL_TRANSPORT=log` with `NODE_ENV=production` fails; the same value passes in development; `MAIL_TRANSPORT=smtp` without credentials fails

## 3. Transactional email

- [x] 3.1 Define the `MailerService` port in `src/infrastructure/mail/` — recipient, subject, text body only; no provider-specific options on the interface
- [x] 3.2 Implement `LogMailerService`: logs recipient and subject, retains the last N messages in a bounded in-memory ring buffer, and never writes verification or reset tokens to the log stream
- [x] 3.3 Implement `SmtpMailerService` on `nodemailer` from the `mail` namespace
- [x] 3.4 Create `MailModule` selecting the adapter from `MAIL_TRANSPORT` and exporting the port; expose the recorded-message buffer for tests
- [x] 3.5 Ensure dispatch failures log at `error` with the request id and propagate as a failed request rather than being swallowed
- [x] 3.6 Tests: log transport records without network delivery; a recorded message's link is extractable; the buffer discards oldest beyond its limit; a failing transport logs at `error` and propagates; no log entry contains a token or the SMTP password

## 4. Schema, migration, and seed

- [x] 4.1 Hand-write Better Auth's `User`, `Session`, `Account`, `Verification`, and `TwoFactor` models into `prisma/schema.prisma`, using `@better-auth/cli generate` output as reference only — keep the model names Better Auth queries by, `@@map` tables to snake_case, and preserve the file's hand-maintained comments
- [x] 4.2 Add `Role`, `Permission`, `RolePermission`, and `UserRole` models; put composite unique constraints on `RolePermission(roleId, permissionId)` and `UserRole(userId, roleId)` so idempotency is enforced by the database, not by seed logic
- [x] 4.3 Keep `AppSetting` — the persistence round-trip test must stay independent of identity
- [x] 4.4 Declare the permission catalogue in code as a `const` array with a derived union type, so a decorator naming an unknown permission is a compile error
- [x] 4.5 Generate and commit the migration via `prisma migrate dev`; confirm every new table name is snake_case
- [x] 4.6 Extend `prisma/seed.ts` to upsert the permission catalogue and baseline roles with their mappings, still upsert-only
- [x] 4.7 Tests: seed twice exits `0` with no duplicates and no unique-constraint error; the persisted catalogue equals the code declaration; adding a permission in code and re-seeding adds only that row; re-seeding an existing mapping is a no-op; schema contains no plan, subscription, entitlement, or credit-ledger model

## 5. Better Auth instance and mount

- [x] 5.1 Implement the Redis `secondaryStorage` adapter on the existing `REDIS_CLIENT` (`get`, `set` with TTL, `delete`), catching its own errors and resolving to `null`/quietly so a Redis outage degrades to a cache miss, logging at `warn` with the request id
- [x] 5.2 Build the `betterAuth()` instance from the `auth` namespace: `prismaAdapter` over the existing `PrismaService`, `basePath: '/api/auth'`, `secret`, `baseURL`, `trustedOrigins` from `CORS_ORIGINS`, `secondaryStorage`
- [x] 5.3 Set `session: { storeSessionInDatabase: true, preserveSessionInDatabase: false, expiresIn, updateAge }` — this exact pair is what makes a cache miss fall through to Postgres; leave `cookieCache` disabled so revocation is immediate, and comment why (design decision 3)
- [x] 5.4 Configure `emailAndPassword` with `enabled`, `requireEmailVerification: true`, and min/max password length; wire `sendResetPassword` to the mailer port
- [x] 5.5 Configure `emailVerification` with `sendVerificationEmail` through the mailer port and send-on-sign-up enabled
- [x] 5.6 Configure `socialProviders` from the derived provider list so an absent group leaves the provider unroutable
- [x] 5.7 Add the `bearer` plugin so the same session token is accepted as `Authorization: Bearer`
- [x] 5.8 Set `advanced`: `useSecureCookies` (off only for local plain HTTP), `defaultCookieAttributes` (`httpOnly`, `sameSite: 'lax'`, `path: '/'`), `cookiePrefix`, and `ipAddress.ipAddressHeaders` from `TRUST_PROXY`
- [x] 5.9 Create `BetterAuthMiddleware` wrapping `toNodeHandler(auth)`, and register it in `AppModule.configure()` for `api/auth/{*splat}` — ordered after `RequestContextMiddleware` so auth log lines carry the request id, which a raw `app.use()` mount would lose
- [x] 5.10 Create the app with `bodyParser: false` and register `json()`/`urlencoded()` as middleware ordered *after* the auth mount with `.exclude('api/auth/{*splat}')`, since `toNodeHandler` needs the unconsumed stream
- [x] 5.11 Move the app-creation options into one shared definition used by both `main.ts` and `test/create-test-app.ts`, so the helper cannot drift from the server on `bodyParser` (it currently passes only `{ logger: false }`)
- [x] 5.12 Expose an `AuthService` wrapping `auth.api.getSession({ headers })` with `fromNodeHeaders`, as the one place session resolution happens
- [x] 5.13 Tests (e2e): sign-up returns success and records a verification message; `/api/v1/auth/sign-in/email` returns `404` while `/api/auth/sign-in/email` works; a JSON auth body is read without hanging; an application route under `/api/v1` still receives a parsed, validated DTO; an auth response carries `x-request-id` and its log lines carry the same id; sign-in before verification establishes no session; following the verification link then signing in establishes one; reusing the verification link fails; reset for an unregistered address is indistinguishable from a registered one; completing a reset invalidates existing sessions

## 6. Principal in the request context and logging

- [x] 6.1 Add `userId?: string` to `RequestContextStore` and a `getUserId()` accessor, keeping the store free of injected dependencies so nothing becomes request-scoped
- [x] 6.2 Add `customProps` in the logger options to emit `userId` alongside `requestId` when present
- [x] 6.3 Extend logger `redact` paths to cover the session cookie by name, session tokens, TOTP and backup codes, verification and reset tokens, OAuth client secrets and provider tokens, and the SMTP password — at the same three-level depth the existing paths use
- [x] 6.4 Tests: a nested service reads the current user id during an authenticated request; an authenticated request's log entries carry both ids; a public-route request carries a request id and no user id; a session token in a `set-cookie` never appears in serialized output; a logged object containing a provisioning secret, a backup code, or a reset token is redacted; entries written before and after the principal resolves share one request id

## 7. Guards, decorators, and deny-by-default

- [x] 7.1 Implement `@Public()`, `@RequirePermissions(...)` (typed against the catalogue union, all required), `@RequireRoles(...)` (any sufficient), and `@CurrentUser()`
- [x] 7.2 Implement `AuthGuard`: resolve the session via `AuthService`, `401 UNAUTHORIZED` when absent or expired, `403` with the distinct unverified-email code when the account's address is unverified, set `userId` on the ALS store and the principal on the request
- [x] 7.3 Implement the effective-permission resolver over `UserRole` → `RolePermission` → `Permission`, resolving at most once per request
- [x] 7.4 Cache effective permission sets in Redis at `perm:<userId>:<version>`, invalidating by bumping the version counter rather than deleting keys; fall back to Postgres on any cache read failure
- [x] 7.5 Implement `PermissionsGuard` reading both decorators via `Reflector` with method-level precedence over controller-level; `403 FORBIDDEN` when unsatisfied, with a generic message that does not enumerate the policy
- [x] 7.6 Log every denial with request id, principal, route, and the unmet requirement
- [x] 7.7 Register both guards as `APP_GUARD` providers in the auth module — not `useGlobalGuards()` — so `Test.createTestingModule` gets the same posture as the server, matching how the foundation registered its pipe, filter, and interceptor
- [x] 7.8 Document the chain order (authenticate → authorize → reserved: entitlements → throttle/limits → credits) next to the registration, and state that later guards must consume the resolved principal rather than re-resolve the session
- [x] 7.9 Mark `/health/live` and `/health/ready` `@Public()` — otherwise readiness fails closed and an orchestrator kills a healthy pod
- [x] 7.10 Mark the routes in `test/fixtures/contract-fixture.module.ts` `@Public()` — otherwise the foundation's envelope and validation e2e tests all become `401`s and read as an envelope regression
- [x] 7.11 Add the new error codes (`EMAIL_NOT_VERIFIED`, `TWO_FACTOR_REQUIRED`, `ACCOUNT_LOCKED`) to `ErrorCode` without renaming or repurposing any existing code
- [x] 7.12 Tests (e2e): an unannotated route returns `401` without a session and never runs its handler; a `@Public()` route runs; health probes return their documented statuses uncredentialed; an authenticated user without the permission gets `403` and the body enumerates nothing; with the permission the handler runs; two required permissions with only one held gives `403`; any-of-two roles succeeds with one; method-level annotation overrides controller-level; `@CurrentUser()` receives the authenticated identity; a session for an unverified account gives the distinct code, not `401`; two requirements in one request resolve the permission set once
- [x] 7.13 Tests: granting a role at runtime takes effect on the next request; changing a role's mapping is observed without redeploy; removing a role revokes its permissions; a user with two roles gets the union; permission cache unavailable still permits a permitted user; entries under a superseded version are never read

## 8. Two-factor authentication

- [x] 8.1 Add the `twoFactor` plugin with the issuer from config and backup codes enabled
- [x] 8.2 Confirm enrolment requires the password and does not activate until a valid code is submitted, so a misconfigured authenticator cannot lock a user out
- [x] 8.3 Ensure a pending challenge is not a usable session: `AuthGuard` must reject it with the `TWO_FACTOR_REQUIRED` code rather than authenticate it
- [x] 8.4 Add first-party endpoints for two-factor status (including remaining backup-code count), enable, disable (password required), and re-issue backup codes (password required, invalidating the previous set)
- [x] 8.5 Add `@better-auth/utils` as an explicit dev dependency so tests can compute valid TOTP codes rather than relying on a transitive dependency
- [x] 8.6 Tests (e2e): enrolment without the password is rejected; a valid code activates and returns backup codes; an unconfirmed enrolment leaves password-only sign-in working; with 2FA active a correct password yields a challenge and no usable session; the challenge cannot reach a protected route; a valid TOTP completes it; an unused backup code completes it; the same backup code reused is rejected; the persisted record holds no plaintext usable codes; re-issuing invalidates the old set; disabling requires the password and clears secret and codes; a wrong password with 2FA active does not reveal that 2FA is active
- [x] 8.7 Tests: no log entry contains a provisioning secret, provisioning URI, submitted code, or backup code

## 9. Auth throttling and account lockout

- [x] 9.1 Enable Better Auth's `rateLimit` with `storage: 'secondary-storage'` over the same Redis adapter, so counters are shared across instances
- [x] 9.2 Add `customRules` markedly tighter for `/sign-in/email`, `/sign-up/email`, `/forget-password`, and the 2FA verification paths than for the rest of the surface, with values from config
- [x] 9.3 Implement per-account lockout in a `hooks.before` on the sign-in paths, keyed by `sha256(normalized email)` plus a coarse IP bucket, with exponential backoff to a cap and a window that expires on its own TTL — no sticky lock and no admin unlock step
- [x] 9.4 Clear the failure counter on successful sign-in
- [x] 9.5 Ensure attempts against an unregistered identifier consume the same counters and return the same status, shape, and rate-limit metadata, so the limiter is not an account-existence oracle
- [x] 9.6 Make the limiter fail **closed** on auth routes when its storage is unavailable, distinguishably from invalid credentials, and confirm the failure is confined to the auth surface — the deliberate opposite of the session cache's fail-open posture (design decision 8)
- [x] 9.7 Return `429` with retry timing, and error code `RATE_LIMITED` where the envelope applies
- [x] 9.8 Set Express `trust proxy` and Better Auth's address headers from `TRUST_PROXY`, and confirm forwarded headers are ignored by default
- [x] 9.9 Do **not** add `@nestjs/throttler` or any global throttle guard — application-wide throttling and usage limits belong to a later change that will own the key and storage design
- [x] 9.10 Tests (e2e): exceeding the sign-in limit returns `429` until the window elapses; strict paths permit fewer attempts than general auth paths; non-auth routes are unaffected while the auth limit is exhausted; failures distributed across many addresses against one account trip lockout; the required wait grows to the cap and no further; lockout self-heals after the window with no admin action; success below the threshold clears the counter; registered and unregistered identifiers are indistinguishable in permitted attempts and responses; a forged forwarded header does not bypass the limit; case variants of one address share a counter; no raw email appears in the limiter keyspace; with limiter storage down sign-in is refused distinguishably while authenticated application routes keep serving

## 10. Security headers, CORS, and cookies

- [x] 10.1 Register Helmet in `configureApp` with an API-appropriate policy: `default-src 'none'`, `frame-ancestors 'none'`, `no-referrer`, nosniff, HSTS only when serving HTTPS; disable `x-powered-by`
- [x] 10.2 Enable CORS from the `CORS_ORIGINS` allowlist with `credentials: true`, granting no permissive headers to an absent origin
- [x] 10.3 Confirm Better Auth's `trustedOrigins` and the CORS allowlist come from the same config value, with no second place to configure origins
- [x] 10.4 Confirm helmet and CORS are registered so they also cover `/api/auth/*` and error responses
- [x] 10.5 Tests (e2e): security headers present on application, auth, and error responses; CSP permits no sources and denies framing; no framework-advertising header; HSTS present only under HTTPS config and absent under local HTTP; an allowlisted origin gets that specific origin plus credentials; a non-allowlisted origin gets no grant; preflight from an allowlisted origin succeeds; a state-changing auth request from an untrusted origin is rejected; an issued cookie carries `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`; the local plain-HTTP cookie drops only `Secure`; the social-redirect return leg carries the cookie and establishes the session

## 11. First-party endpoints

- [x] 11.1 Add `GET /api/v1/me` returning the current principal with roles and effective permissions, inside the response envelope
- [x] 11.2 Add own-session management: list the user's sessions, revoke one by id, revoke all but the current
- [x] 11.3 Confirm revocation takes effect on the very next request with no cached-credential window, in both cookie and bearer transports
- [x] 11.4 Add no admin endpoints for managing other users' roles or sessions — that surface belongs to the admin-monitoring change
- [x] 11.5 Tests (e2e): `/api/v1/me` returns the envelope and correct roles and permissions; sign-out then immediate token reuse is rejected; revoking a listed session stops it while the current one works; revoke-all-others leaves only the current session; cookie and bearer transports resolve to the same session and are both revoked together

## 12. Docker, CI, documentation, and close-out

- [x] 12.1 Add the new variables to `compose.yaml` and `compose.dev.yaml`, and to the CI workflow environment with non-secret test values; confirm CI's Node 22 resolves to ≥22.12
- [x] 12.2 Confirm the production image still builds and boots, and that the boot smoke test passes with auth wired — the guard against alias and ESM-resolution drift in the compiled artifact
- [x] 12.3 README: the `/api/auth/*` surface, that it returns Better Auth's shapes and **not** the application envelope, and why it sits outside `/api/v1`
- [x] 12.4 README: the guard chain and its reserved positions, `@Public()` as the only way to open a route, and how to audit open routes
- [x] 12.5 README: the RBAC model — runtime-editable assignments over a code-declared catalogue — and how to add a permission and grant it
- [x] 12.6 README: the documented knobs and their consequences — enabling `session.cookieCache` (revocation lag), `SameSite=None` for a cross-domain SPA, and Better Auth's default account-linking behaviour for a matching verified email, so a fork confirms it against its own threat model
- [x] 12.7 README: the two-factor enrolment and recovery flows, and the mail transport options including why `log` is rejected in production
- [x] 12.8 Run the full local gate — `lint`, `typecheck`, `test`, `test:e2e`, `build`, `test:smoke`, Compose up → `/health/ready` — and confirm every task above is checked
