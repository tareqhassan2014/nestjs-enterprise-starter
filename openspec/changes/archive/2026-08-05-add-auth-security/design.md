## Context

The platform foundation (archived `add-platform-foundation`) established validated config, a global request/response envelope, `AsyncLocalStorage` request context, structured logging, Prisma, a shared Redis client, and health probes. It shipped no user model and no notion of a caller — deliberately, so this change would not have to fight a placeholder `User` in a migration.

Two extension points were reserved for exactly this work and are used here rather than re-invented: `RequestContextStore` is a record specifically so auth could add `userId`, and the `REDIS_CLIENT` provider was described as "provisioned and health-checked here; the throttling and usage-limit changes are what will actually consume it."

Constraints that shape the design:

- **`better-auth@1.6.25` is ESM-only.** `"type": "module"`, `.mjs` output, and no `require` condition anywhere in its exports map. This project compiles to **CommonJS** (`module: nodenext`, no `"type": "module"`, SWC emitting CJS). Bridging the two is the single largest technical risk in this change and is settled empirically in Decision 1.
- **Better Auth needs the unparsed request body.** Nest registers its body parsers before module middleware, so the default wiring consumes the body before any auth handler could see it.
- **Better Auth is a router, not a Nest citizen.** It owns ~30 routes, their payload validation, and their error shape. It cannot be run through Nest's global pipe, envelope interceptor, or exception filter — which means the foundation's "applies by default" contract has a documented hole in it, and the specs must say where.
- **Express 5 / NestJS 11.** Path patterns are `{*splat}`-style; `MiddlewareConsumer.exclude()` is the supported way to scope middleware away from a path.
- **Prisma 7 with a hand-written schema.** `prisma/schema.prisma` is hand-maintained with explanatory comments and `@@map`ped snake_case tables; anything that rewrites it wholesale is unwelcome.
- **This is a template.** Every decision is inherited by forks that will not read this document. Defaults must be the safe ones, and the unsafe-but-sometimes-needed variants must be reachable by editing one obvious place.

## Goals / Non-Goals

**Goals:**

- A caller's identity is established once per request, by one mechanism, and is available to any code in the call stack — including code with no HTTP awareness — through the context facade that already exists.
- Deny-by-default: a route added by a fork is protected before anyone thinks about protecting it. Opening a route is a visible, greppable act.
- Authorization decisions are data (editable at runtime) while the vocabulary of permissions is code (typed, greppable, impossible to misspell in a decorator).
- Redis is a cache and a counter store, not a second source of truth. A Redis outage degrades performance and blocks new abuse, but does not invent or destroy sessions.
- The credential surface is expensive to attack and cheap for a legitimate user to recover from, and reveals nothing about which accounts exist.
- Every boundary where the foundation's uniform contract does *not* apply is named explicitly, in a spec, rather than discovered by a fork whose client broke.

**Non-Goals:**

- Plans, entitlements, credits, Stripe, global throttling, admin APIs, organizations, JWT issuance, passkeys, magic links (see proposal Non-goals). The guard chain reserves its position for entitlements and credits; it does not implement them.
- A generalized policy engine (ABAC, row-level rules, `can(user, action, resource)` with resource instances). Permissions are flat `resource:action` strings. Resource-scoped checks stay in service code where the resource is already loaded.
- Replacing or wrapping Better Auth's own routes with Nest controllers to force them into the envelope.

## Decisions

### 1. Load ESM-only `better-auth` from CommonJS via `require(esm)`, verified rather than assumed

Every claim here was checked against `better-auth@1.6.25` installed in a scratch directory, not read from documentation.

**Runtime.** Node's `require(esm)` support (unflagged since **22.12.0**) loads the package from our CJS output. Confirmed by requiring every entry point this change needs, all of which returned live bindings:

| Specifier | Bindings used |
| --- | --- |
| `better-auth` | `betterAuth`, `APIError` |
| `better-auth/node` | `toNodeHandler`, `fromNodeHeaders` |
| `better-auth/adapters/prisma` | `prismaAdapter` |
| `better-auth/plugins/two-factor` | `twoFactor` |
| `better-auth/plugins/bearer` | `bearer` |

`require(esm)` throws on a graph containing top-level `await`; that all five resolved is direct evidence this graph has none. TypeScript 5.9 with `module: nodenext` types and permits these as ordinary `import` statements, and SWC emits them as `require`, so **no source-level accommodation is needed** — the auth module imports Better Auth like any other package.

**Tests.** This is where it bites, and where it nearly bit silently. Under plain `jest`, a ts-jest-compiled (CJS) test importing `better-auth` fails with `SyntaxError: Cannot use import statement outside a module` — Jest's own module registry intercepts the require and never reaches Node's `require(esm)`. Under `NODE_OPTIONS=--experimental-vm-modules`, the same test passes. Both were run; the failure is not hypothetical.

The project's `test` and `test:e2e` scripts **already** set that flag, for unrelated reasons. It is now load-bearing, so:
- it must be documented as such where it is set, not left looking incidental;
- `test:debug`, which does not set it, must be brought in line or it will fail the moment anyone debugs an auth test.

**`engines.node` tightens from `>=22` to `>=22.12`.** The Docker base image and CI both pin Node 22 and resolve to a recent patch, so nothing breaks; the floor exists so a fork pinning 22.0 gets a clear install-time error instead of a confusing runtime one.

- **Rejected: `await import('better-auth')` inside an async factory provider.** Works, and is the reflex answer, but it forces the auth instance to be async-provided, which spreads into every consumer's typing and into module init ordering — real, permanent ergonomic cost to route around a problem the runtime does not actually have on our supported Node floor.
- **Rejected: converting the project to ESM.** One dependency does not justify re-settling `nest build`, `.swcrc`, ts-jest, the Prisma generator's `moduleFormat`, and the seed script's ts-node hook — all of which the foundation tuned together and verified with a boot smoke test.
- **Rejected: bundling/vendoring the library.** Opaque, and a fork could not upgrade it.

### 2. Mount Better Auth as Nest middleware at `/api/auth/*`, with body parsing sequenced around it

Path choice: `/api/auth/*`, **outside** the `/api/v1` version segment. This is the same rule the foundation applied to `/health/*`, for the same reason: the library owns that route contract, so it must not move when *our* API version moves. A fork's mobile client should not need a new build because the business API went to `v2`.

Registration is via `MiddlewareConsumer`, not a raw `app.use()` in `configureApp`. Middleware registered with `app.use()` before `init()` runs *ahead* of everything Nest registers, including `RequestContextMiddleware` — so a raw mount would put every auth request outside the ALS scope and strip `requestId` from exactly the log lines most worth correlating. Inside the consumer chain, ordering is explicit and declared in one place:

```
RequestContextMiddleware        forRoutes('{*splat}')        // ALS scope opens first
pino-http (nestjs-pino)         forRoutes('{*splat}')        // already ordered after context
BetterAuthMiddleware            forRoutes('api/auth/{*splat}')  // ends the response; never reaches a route
json() + urlencoded()           exclude('api/auth/{*splat}')    // everything else gets a parsed body
```

Nest is therefore created with **`bodyParser: false`**, and JSON/urlencoded parsing becomes explicit middleware ordered *after* the auth mount and excluded from its paths. `toNodeHandler` reads the stream itself; a parsed-and-consumed body would surface as a hung or empty auth request.

The trap: `test/create-test-app.ts` builds the app through `moduleRef.createNestApplication({ logger: false })`, which does **not** inherit `main.ts`'s options. Unless the helper also passes `bodyParser: false`, e2e tests exercise a body-parsing arrangement the server never uses — the exact class of divergence the helper was written to prevent. The helper and `main.ts` must take their app options from one shared place.

Helmet and CORS *do* go in `configureApp` via `app.use`/`enableCors`, deliberately: they must cover the auth surface too, they never touch the body, and running them before the ALS scope costs nothing.

- **Rejected: `app.use('/api/auth', toNodeHandler(auth))` raw.** The common recipe, and it loses request correlation on the auth surface.
- **Rejected: wrapping Better Auth's routes in Nest controllers** to bring them under the envelope and the global pipe. That means re-declaring ~30 endpoints and their DTOs, and re-breaking them on every upgrade, to gain response-shape uniformity on routes whose consumer is Better Auth's own client library.

### 3. Redis as a session cache with Postgres authoritative — enabled by one non-obvious option pair

Sessions are rows in Postgres (revocable, listable, durable) and cached in Redis through Better Auth's `secondaryStorage`, implemented on the existing shared `REDIS_CLIENT`. The interface is `get(key)`, `set(key, value, ttl?)`, `delete(key)`, with optional `getAndDelete`/`increment`.

Naively configured, this is a trap: **with `secondaryStorage` set, Better Auth stores sessions in Redis *only*, and reads always go to Redis.** A cache eviction or a Redis restart would silently log every user out. The fix is a specific pair of settings, and the reason it works was read out of the library's source rather than inferred:

```ts
session: { storeSessionInDatabase: true, preserveSessionInDatabase: false }
```

In `internal-adapter.mjs`, the session read is:

```js
const sessionStringified = await secondaryStorage.get(token);
if (!sessionStringified && (!storeSessionInDatabase || preserveSessionInDatabase)) return null;
if (sessionStringified) { /* return the cached session */ }
// …otherwise falls through to the database lookup
```

So with that pair — and **only** with that pair — a Redis miss falls through to Postgres. `preserveSessionInDatabase` must stay `false` for two reasons: setting it disables the fallback (per the condition above), and it would leave revoked session rows behind after deletion.

Consequences that follow, and that the specs pin down:

- Our `secondaryStorage` adapter **catches its own errors and returns `null`/resolves quietly**, converting a Redis outage into a cache miss. Combined with the fallback, authenticated traffic keeps working off Postgres, degraded but correct. This is the one place where swallowing an error is right; it is logged at `warn` with the request id.
- **Revocation is immediate**, because there is no signed-cookie session cache in front of Redis (see below).
- Redis eviction is a performance event, not a logout event — which is what makes the shared client's `enableOfflineQueue: false` (fail fast) safe here rather than hostile.

`session.cookieCache` is deliberately **left disabled**. It would cut the Redis read too, but it puts the session in a client-held signed cookie for its `maxAge`, which means revocation does not take effect until that window expires. Database sessions were chosen for revocability; buying latency by giving that back is the wrong default for a template whose next features are billing and credits. It is called out in the README as the knob to turn if a fork needs it, with the revocation lag stated.

### 4. Two transports over one session: hardened cookie for browsers, `bearer` plugin for everything else

The cookie is `HttpOnly`, `SameSite=Lax`, signed, `Secure` outside local HTTP, path `/`. The `bearer` plugin accepts the *same session token* as `Authorization: Bearer …` for mobile and CLI clients.

One session model means one revocation path, one expiry rule, and one thing to reason about. Adding a second credential format (JWT) would mean either accepting that revocation does not apply to it, or building a denylist — and the `jwt` plugin is a non-goal precisely because nothing yet needs stateless verification.

`SameSite=Lax` over `Strict` because `Strict` breaks the OAuth redirect return, and over `None` because `None` requires `Secure` and opens cross-site sends; a fork serving a browser SPA from a different registrable domain needs `None` plus a real CORS origin and is pointed at the one place to change it.

### 5. RBAC: assignments in the database, vocabulary in code

Four tables — `Role`, `Permission`, `RolePermission`, `UserRole` — with a user holding many roles. Assignments and role→permission mappings are editable at runtime, which is the requested model.

The vocabulary is not. Permissions are declared as a `const` array in code, from which a union type is derived, so `@RequirePermissions('user:raed')` is a **compile error** rather than a check that silently never passes. The seed upserts that catalogue into `Permission`. A permission row present in the database but absent from code is inert; the guard only ever asks about permissions the code names.

This is the split that makes "DB-driven" safe: an operator can grant and revoke, but cannot invent a permission string that no guard consults, and cannot typo one that a guard does.

Resolution and caching:

- The guard resolves the caller's effective permission set once per request and stashes it on the request.
- The set is cached in Redis under `perm:<userId>:<version>`, where `version` comes from a counter bumped on any role or mapping mutation. **Invalidation is a version bump, not a key delete** — no key enumeration, no scan, and no stale-entry hunt when a role's mapping changes for thousands of users at once. Old keys expire on their TTL.
- Cache read failure falls through to Postgres, matching Decision 3's posture: availability degrades, correctness does not.

- **Rejected: Better Auth's `access` plugin (`createAccessControl`).** Its statements are code-defined, which directly contradicts the runtime-editable requirement, and it would put a second authorization vocabulary next to ours.
- **Rejected: Better Auth's `admin` plugin.** It carries a `role` string on the user, which would compete with `UserRole` as the source of truth. Its ban/impersonate features are genuinely useful and belong to the admin-monitoring change, which can adopt it once role storage is settled here.
- **Rejected: caching the *decision* per (user, permission).** Cheaper reads, far more keys, and a mapping change becomes N invalidations. Caching the whole set keeps invalidation to one bump.

### 6. Two global guards: authenticate, then authorize, deny by default

Registered as `APP_GUARD` providers in the auth module — not `app.useGlobalGuards()` — so tests that build the app through `Test.createTestingModule` get the same posture as the server. This mirrors how the foundation registered its pipe, filter, and interceptor, and for the same reason.

```
AuthGuard          resolves the session (cookie or bearer) → 401 if absent/expired
                   → sets userId on the ALS store and the principal on the request
PermissionsGuard   reads @RequirePermissions / @RequireRoles → 403 if unsatisfied
[reserved]         entitlements → throttle/limits → credits, in that order
```

The order is the one AGENTS.md mandates, and the reserved positions are named in the spec so later changes extend the chain instead of introducing a parallel one. A later guard must read the principal the `AuthGuard` already resolved rather than re-resolving the session.

Decorators: `@Public()` (skip both guards), `@RequirePermissions(...)`, `@RequireRoles(...)`, `@CurrentUser()`. `@Public()` is the only way to open a route, and it is one grep away from an audit.

Two consequences worth stating because they will otherwise be discovered as bugs:

- `/health/*` must be `@Public()`, or readiness probes start failing closed and the orchestrator kills a healthy pod.
- `test/fixtures/contract-fixture.module.ts` routes must be `@Public()`, or the foundation's envelope and validation e2e tests all turn into 401s — which would read as "the envelope broke."

`AuthGuard` distinguishes *unverified* from *unauthenticated*: a session for an unverified email yields `403 EMAIL_NOT_VERIFIED`, not a generic 401, because the client's remedy is different.

### 7. Principal in `AsyncLocalStorage`, reusing the reserved extension point

`RequestContextStore` gains `userId?: string`. `AuthGuard` writes it after resolving the session; `nestjs-pino`'s `customProps` picks it up alongside `requestId`, so every log line emitted during an authenticated request identifies the actor without any call site passing it.

The store stays a plain record with no injected dependencies, so nothing becomes request-scoped — the foundation's reasoning about request-scoped providers poisoning the injection graph applies unchanged.

Guards run *after* middleware, so the `userId` is absent from the request-completion log line emitted by `pino-http`, which is written at response time — acceptable, since `requestId` joins the two. Making it available earlier would mean resolving the session in middleware, i.e. a second session-resolution path.

### 8. Auth throttling on Better Auth's limiter; account lockout as our own layer

These are two different problems and get two mechanisms.

**Per-path/IP throttling** uses Better Auth's built-in limiter with `storage: 'secondary-storage'`, sharing the Redis adapter from Decision 3, plus `customRules` that are markedly tighter on `/sign-in/email`, `/sign-up/email`, `/forget-password`, and the 2FA verification paths than on the rest of the surface. This deliberately does **not** pull in `@nestjs/throttler`: application-wide throttling is a later change that will own that dependency, the global guard, and the key scheme, and pre-empting its design here would force it to unpick this one.

**Per-account lockout** is ours, because an IP-keyed limiter does nothing about a distributed attack on one account. A `hooks.before` hook on the sign-in paths keys counters in Redis by `sha256(normalized email)` plus a coarse IP bucket — hashed so raw addresses are not sitting in Redis keys, log dumps, or `MONITOR` output. After a threshold, retry delay grows exponentially to a cap, and the window **self-heals via key TTL**: no sticky lock, no admin unlock step, no attacker-triggerable denial of a real user's account. That is what "lockout-friendly" has to mean for a template.

Non-disclosure is a property of the *counter keying*, not of the response text: an attempt against an unregistered address consumes the same counters and returns the same shape and timing class as a wrong password. Otherwise the limiter itself becomes the account-existence oracle that the error messages were careful not to be.

**Failure posture is asymmetric, on purpose.** If the limiter's storage is unavailable, auth routes **fail closed** (reject) — an unmetered credential endpoint is worse than an unavailable one — while the rest of the API is unaffected, since nothing else consults it. This is the deliberate opposite of Decision 3's session cache, which fails open onto an authoritative store. Two different questions: "is this the real user?" has a durable answer in Postgres; "how many times have they tried?" does not.

### 9. Security headers, CORS, and one origin allowlist feeding both

Helmet with an API-appropriate policy rather than its browser-page defaults: `default-src 'none'` and `frame-ancestors 'none'` (this service returns JSON; it has no scripts, styles, or frames to permit), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, HSTS only when serving over HTTPS. `x-powered-by` off.

CORS reads a comma-separated `CORS_ORIGINS` allowlist with `credentials: true`. Because credentialed CORS and `*` are incompatible — browsers reject the combination, and a server that sends both is misconfigured rather than permissive — **the env schema rejects `*` when the list is non-trivial**, at boot, instead of leaving it to a browser console at integration time.

That same list feeds Better Auth's `trustedOrigins`, which drives its CSRF origin check. Deriving both from one variable is the whole point: two lists would drift, and the failure mode of drift is either a CSRF hole or an inexplicable 403 on a correctly-configured client.

`TRUST_PROXY` is added to config because every IP-keyed decision in Decision 8 is wrong behind a load balancer that has not been accounted for. It sets Express's `trust proxy` and Better Auth's `advanced.ipAddress.ipAddressHeaders` together, so client-IP resolution has one answer. Default is off — trusting `X-Forwarded-For` by default lets any client forge its own rate-limit identity.

### 10. Conditionally required secret groups in the env schema

The foundation's rule — secrets are mandatory and never defaulted — cannot express "Apple OAuth is optional, but half-configured Apple OAuth is a bug." A Zod `superRefine` handles credential *groups*: absent entirely is valid and disables the provider; partially present is a boot failure naming the missing members. The enabled-provider list is then **derived** from which groups are present, so there is no separate `GOOGLE_ENABLED` flag to contradict the credentials.

`BETTER_AUTH_SECRET` is required with a 32-character minimum, and — like `DATABASE_URL` — has no default in any environment.

Mail gets the same treatment with one extra rule: `MAIL_TRANSPORT=log` is **rejected when `NODE_ENV=production`**. The log adapter is the right default for development and the worst possible accident in production, where it would mean every verification and reset email silently vanishing while sign-up appears to succeed. A misconfiguration that fails at boot is strictly better than one that fails as unreachable users.

### 11. Mailer as a port with two adapters

An abstract `MailerService` with `LogMailerService` (logs the message, retains the last N in memory so e2e tests can assert on a verification link without an SMTP server) and `SmtpMailerService` (nodemailer). Auth code depends only on the port, so a fork swaps in Resend or SES by writing one class and changing one config value.

`nodemailer` over a hosted provider's SDK because SMTP is the one transport every provider speaks, which keeps the template vendor-neutral.

Delivery failures are logged at `error` with the request id and propagate as a failed request rather than being swallowed. The honest consequence: a sign-up whose verification mail fails leaves a real, unverified user row behind. That is recoverable — the resend endpoint is the documented path — and is better than either pretending success or rolling back an account the user believes they created.

### 12. Hand-write Better Auth's Prisma models; verify with the CLI rather than generating over the schema

`@better-auth/cli generate` can emit Prisma models, but it rewrites the schema file, and ours is hand-maintained with explanatory comments and `@@map`ped snake_case tables that match `app_settings`. The models are written by hand using the CLI's output as the reference, keeping Better Auth's expected **model** names (`User`, `Session`, `Account`, `Verification`, `TwoFactor` — it queries by model name) while `@@map`ping table names to the project's convention.

The migration is produced by `prisma migrate dev` and committed, per the foundation's versioned-migrations requirement. Nothing auto-migrates at boot.

The seed extends to the permission catalogue and baseline roles, still `upsert`-only. Its idempotency obligation grows: re-running must not duplicate role→permission rows, which means the join table needs a composite unique constraint doing that work in the database rather than in seed logic.

## Risks / Trade-offs

**`require(esm)` is a Node-version-dependent bridge** → Verified working for every entry point used, with a `>=22.12` engine floor, and the CI boot smoke test already exercises the compiled artifact. A Node downgrade below the floor fails at install.

**Jest needs `--experimental-vm-modules` to load an ESM-only dependency, and the flag looks incidental** → It is already set in `test` and `test:e2e`; this change documents it as load-bearing at the point it is set and fixes `test:debug`. The failure mode is loud (`SyntaxError` at import) rather than subtle.

**`--experimental-vm-modules` is, by name, experimental** → Accepted; it is the standard mechanism, and the alternative (mocking `better-auth` in tests) would mean the e2e suite never exercises the real auth surface, which is precisely what needs testing.

**Better Auth's routes bypass the global pipe, envelope, and exception filter** → A permanent, real inconsistency for clients: two response shapes on one origin. Accepted rather than papered over, because wrapping ~30 library-owned routes is a maintenance liability. Made explicit in the `api-response-envelope` delta and in the README, so it is a documented contract rather than a surprise.

**Deny-by-default breaks existing tests and probes the moment it lands** → Known and enumerated (health routes, contract fixtures). Listed as explicit tasks rather than left to be diagnosed as an envelope regression.

**Sessions read through Redis** → Mitigated by the `storeSessionInDatabase: true` / `preserveSessionInDatabase: false` pair, verified against the library's read path, plus an adapter that converts Redis errors into cache misses. Residual: a Redis outage moves session reads onto Postgres, so the database takes load it does not normally see. Readiness already reports Redis down, so an orchestrator pulls the instance from rotation anyway.

**Permission cache invalidation by version bump leaves stale keys until TTL** → Intended: they are unreachable once the version moves, and TTL reclaims them. The cost is memory, not correctness.

**Account lockout is itself a denial-of-service surface** → The reason the window self-heals via TTL and the delay is capped, rather than a sticky lock needing an admin. An attacker can slow a targeted user's sign-in during an active attack; they cannot lock them out durably.

**Rate-limit storage failing closed makes Redis a hard dependency for signing in** → Deliberate: an unmetered credential endpoint is a worse outcome than an unavailable one, and it is bounded to the auth surface while the rest of the API keeps serving.

**Better Auth's default account-linking behaviour is accepted as-is** → An OAuth sign-in matching an existing verified email links to it. Standard, and the alternative (custom merge flow) is product policy. Flagged in the README as a decision a fork should confirm against its threat model.

**Password reset and email verification are only as strong as mail delivery** → Token lifetimes are bounded and single-use; `MAIL_TRANSPORT=log` cannot be selected in production.

**Hashing normalized emails for lockout keys is not anonymization** → It prevents casual disclosure via Redis keyspace inspection and log dumps; it is not a defence against an attacker who can already run commands against Redis. Stated so nobody mistakes it for more than it is.

**Six new capabilities and a modified data model is a large change** → Sequenced in the migration plan so the app boots and the suite passes at every step, with the two globally breaking steps (deny-by-default, `bodyParser: false`) landing behind the mechanisms they depend on.

## Migration Plan

No data migration: there is no deployed instance, no released consumer, and no existing user rows. Ordering exists so the app boots and tests pass at each step rather than only at the end.

1. **Dependencies and toolchain.** `better-auth`, `helmet`, `nodemailer`, `@types/nodemailer`; `engines.node` to `>=22.12`; fix `test:debug`'s missing flag and document why it matters. Verify `require('better-auth')` from the compiled artifact before building anything on it.
2. **Config and env contract.** New variables, conditional credential groups, the CORS/`trustedOrigins` shared list, `TRUST_PROXY`, the production `MAIL_TRANSPORT` rule; `.env.example` and `check:env` stay in sync.
3. **Mail port and adapters.** Independently testable, and needed before verification email exists.
4. **Schema and seed.** Better Auth models plus RBAC tables, one migration, catalogue and baseline roles seeded idempotently.
5. **Better Auth instance and mount.** `bodyParser: false`, middleware ordering, shared app options between `main.ts` and `create-test-app.ts`. At this point the auth surface works end to end and *nothing is protected yet* — verifiable in isolation.
6. **Session context and logging.** `userId` in the ALS store, `customProps`, extended redaction.
7. **Guards and decorators — the breaking step.** Deny-by-default lands here, together with `@Public()` on health routes and contract fixtures, so the suite goes red and green within one step.
8. **2FA.** TOTP enrolment, challenge, backup codes.
9. **Throttling and lockout.** Auth rate-limit rules, then per-account lockout.
10. **Helmet, CORS, cookie hardening.**
11. **First-party endpoints** for the current principal, own-session management, and 2FA enrolment.
12. **Docs and close-out.** README sections on the auth surface, the envelope exception, the guard chain, `@Public()`, the `cookieCache` and `SameSite` knobs, and the account-linking default.

**Rollback:** revert the commit; `prisma migrate resolve --rolled-back <migration>` first if the migration reached a shared database, as the README already documents. Rolling back drops user and session data, which is acceptable only because this change is what creates it.

## Open Questions

**Resolved during design:**

1. ~~Can an ESM-only `better-auth` be used from this CommonJS project?~~ → **Resolved: yes, via `require(esm)` on Node ≥22.12, verified against the installed package for every entry point; Jest additionally needs `--experimental-vm-modules`, already set.** See Decision 1.
2. ~~Does `secondaryStorage` make Redis a single point of failure for sessions?~~ → **Resolved: no, with `storeSessionInDatabase: true` and `preserveSessionInDatabase: false`, confirmed against the library's session read path.** See Decision 3.
3. ~~Where does the auth surface sit relative to `/api/v1`?~~ → **Resolved: `/api/auth/*`, outside the version segment, on the same reasoning as `/health/*`.** See Decision 2.

**Still open:**

4. **Whether `@nestjs/throttler` should eventually absorb the auth-route limits.** This change uses Better Auth's own limiter to avoid pre-empting the global-throttling change's key and storage design. Once that change exists, having two limiters may be redundant — or may be correct, since the auth surface never reaches a Nest guard. Revisit then; the cost of consolidating later is configuration, not schema.
5. **Whether backup codes should be re-issuable without re-enrolling TOTP.** Better Auth supports generating a fresh set; the question is product policy about whether that should require a password re-entry. Defaulting to requiring it. Not blocking.
6. **Session listing across devices** is exposed for the current user only. Whether an admin needs to enumerate and revoke another user's sessions belongs to the admin-monitoring change, and depends on decisions this change does not need to make.
