## Context

The repo is a bare `nest new` scaffold: `AppModule`, `AppController`, `AppService`, and a `main.ts` that reads `process.env.PORT` directly. There is no database, no config validation, no logging strategy, and no response contract. `openspec/specs/` is empty — this change writes the first specs.

Seven feature areas are queued behind this one (Better Auth + RBAC, plans/entitlements, Redis throttling, usage limits, credit ledger, Stripe, admin monitoring). Each will need typed config, a place to put cross-cutting guards, a stable error shape, request correlation, and Prisma. If those are invented per-feature, the starter ends up with three ways to read config and two error shapes.

Constraints that shape the design:

- **NestJS 11 / Express 5.** Terminus v11 changed its health-indicator API (`HealthIndicatorService` instead of subclassing `HealthIndicator`); Express 5 changed error propagation for async handlers.
- **SWC builder with `typeCheck: true`** is already configured in `nest-cli.json`. SWC transpiles per-file, which affects how path aliases and decorator metadata are handled.
- **`module: nodenext`**, no `"type": "module"` in `package.json` → CommonJS output, so relative imports do not need explicit extensions.
- **pnpm** single-package workspace with `pnpm-workspace.yaml` already pinning `allowBuilds` for `@swc/core`.
- **This is a template.** Readability and familiarity beat cleverness — a fork should be able to delete a module without archaeology. Every decision below is one a forker inherits.

## Goals / Non-Goals

**Goals:**

- Boot fails loudly and completely on bad configuration, before any port is bound.
- One request/response contract, applied by default rather than opt-in, that downstream features extend instead of replacing.
- A request identifier that is available anywhere in the call stack — including code with no reference to the HTTP request — and appears in both the response and every log line.
- `docker compose up` produces a working app + Postgres + Redis; `pnpm test` and CI verify against real services, not mocks.
- Path aliases that resolve identically under `tsc`, SWC, Jest, ts-node, and `node dist/main`.
- Extension points sized for what is queued: auth guards, throttle guards, entitlement checks, and the credit ledger all slot in without editing the envelope or the config loader.

**Non-Goals:**

- Any auth, billing, credits, throttling, or admin behavior (see proposal Non-goals).
- Metrics, tracing, or log shipping. Structured JSON on stdout is the contract; collection is the operator's problem.
- Multi-tenancy, sharding, or read replicas in the Prisma layer.
- A plugin system or configurable "starter kit" toggles. Forks edit code.

## Decisions

### 1. Zod for env validation, wired through `@nestjs/config`'s `validate` hook

`ConfigModule.forRoot({ validate })` receives raw `process.env` and returns the parsed object. A single Zod schema (`src/config/env.schema.ts`) parses with `safeParse`, and on failure formats **every** issue into one multi-line error before throwing — so a fresh clone with four missing vars learns about all four in one run.

Typed access goes through `registerAs` namespaces (`app`, `database`, `redis`, `logger`), each deriving its values from the already-validated env. Consumers inject `ConfigType<typeof appConfig>` and get full inference with no `!` assertions and no string keys.

- **Why Zod over Joi:** the parsed output is a TypeScript type (`z.infer`), so the config namespaces and the `.env.example` contract stay in sync with the type system rather than by convention. Joi's types are bolted on and its `ValidationOptions` ergonomics are worse for the aggregate-all-errors case.
- **Why `validate` over `validationSchema`:** `validationSchema` is Joi-specific. `validate` is a plain function, so Zod (or anything else) drops in.
- **Coercion belongs in the schema.** `PORT`, pool sizes, and TTLs arrive as strings; `z.coerce.number().int().positive()` is the only place that conversion happens. Nothing downstream calls `parseInt` on config.
- **Rejected:** reading `process.env` behind a hand-rolled `Env` class — loses `@nestjs/config`'s `.env` file layering and testing overrides for no gain.

An ESLint `no-restricted-properties` rule bans `process.env` outside `src/config/**` and `prisma/**`, which is what keeps the discipline from eroding in a fork.

### 2. Layout: `common/` (cross-cutting), `config/` (env), `infrastructure/` (adapters), `modules/` (features)

The split is by *reason to change*, not by artifact type:

```
src/
  common/          # applies to every request: pipes, filters, interceptors,
                   # decorators, dto/, context/ (AsyncLocalStorage)
  config/          # env.schema.ts + namespaces; only place reading process.env
  infrastructure/  # technical adapters: prisma/, redis/, logger/, health/
  modules/         # feature modules — empty at the end of this change
  app.module.ts
  main.ts
```

`infrastructure/` holds things swappable without touching business logic (Postgres → another DB, Pino → another logger). `modules/` holds things that exist because the product needs them. The distinction matters when a fork wants to strip the starter down.

- **Rejected:** flat `src/` with `*.filter.ts` scattered — does not survive seven feature modules.
- **Rejected:** a `libs/` monorepo split (Nest CLI supports it) — real overhead, no payoff at one deployable.

The scaffolded `app.controller.ts` / `app.service.ts` / `app.controller.spec.ts` are deleted rather than repurposed; `AppModule` becomes composition-only.

### 3. `AsyncLocalStorage` for request context, seeded by the same id Pino uses

A `RequestContextMiddleware` runs before everything else. It reads the inbound `x-request-id`, validates it (see Risks — untrusted input), falls back to `randomUUID()`, and calls `als.run({ requestId }, next)`. `pino-http`'s `genReqId` is configured to read from that same store, so log lines, the response envelope, and the `x-request-id` response header all carry one value.

`RequestContext.getRequestId()` is a static read from the store — no injection, no prop-drilling.

- **Why ALS over passing `req.id` around:** queue workers, cron jobs, and the seed script have no `req`. Anything reading context via injection would need a request-scoped provider, and request-scoped providers poison the injection graph of everything that touches them (Nest instantiates the whole subtree per request). ALS is `node:async_hooks` — no dependency, no scope contamination.
- **Why not `nestjs-cls`:** it wraps the same primitive with a DI surface we do not need yet. A fork that wants richer context (tenant, user id) can adopt it later; the `RequestContext` facade is deliberately small enough to swap.
- The store is typed and extensible (`{ requestId: string }` today) — auth will add `userId` here, which is exactly why it is a record and not a bare string.

### 4. Envelope by interceptor, errors by filter, opt-out by decorator

Success — `ResponseEnvelopeInterceptor` (global) wraps whatever a handler returns:

```jsonc
{ "success": true, "data": <handler return>, "meta": { "requestId": "…", "timestamp": "…" } }
```

Failure — `AllExceptionsFilter` (global) catches everything and emits:

```jsonc
{ "success": false, "error": { "code": "VALIDATION_FAILED", "message": "…", "details": [...] }, "meta": { … } }
```

Key points:

- **`code` is a stable string, not the HTTP status.** Clients switch on `code`; status is transport. The enum starts small (`VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`) and is extended by later changes — `RATE_LIMITED` and `INSUFFICIENT_CREDITS` land with throttling and credits, but the *shape* is fixed now.
- **The filter is the only place that decides what leaks.** Non-`HttpException` throws become `INTERNAL_ERROR` with a generic message and are logged at `error` with the stack; the stack never reaches the client. Prisma's `PrismaClientKnownRequestError` is mapped explicitly (`P2002` → `CONFLICT`, `P2025` → `NOT_FOUND`) so features do not each re-map it.
- **`@NoEnvelope()`** (a `SetMetadata` marker, read via `Reflector`) exempts handlers whose consumer is not a client of our API — health probes today, Stripe webhooks and file downloads later. Terminus's own payload shape reaches orchestrators unmodified.
- **Rejected:** wrapping in a base controller class — inheritance is opt-in, and the point is that it applies by default.
- **Rejected:** returning envelopes from handlers explicitly — pushes ceremony into every feature and drifts.

### 5. Global `ValidationPipe`, strict by default

`{ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }`.

`forbidNonWhitelisted` is the deliberate choice: silently stripping unknown keys hides client bugs, and for a billing-adjacent API a typo'd field name that silently does nothing is worse than a 400. Validation errors are flattened by a custom `exceptionFactory` into `details: [{ field, constraint, message }]` so the envelope's `details` is machine-readable rather than a Nest-shaped nested blob.

`enableImplicitConversion` is what makes `@Param('id') id: number` and `?page=2` work without per-DTO `@Type()` decorators. Its cost is genuine (it coerces aggressively — `"abc"` to `NaN` for a `number` field, which then fails `@IsInt()`), and the accompanying rule is: **every** query/param DTO carries explicit `class-validator` decorators. The pipe transforms; the decorators are what actually reject.

- **Note for the billing change:** `forbidNonWhitelisted` will reject Stripe webhook payloads, which carry fields we do not model. Webhook routes take a raw body and bypass the global pipe — recorded here so it is not rediscovered under time pressure.

### 6. `nestjs-pino`, JSON in prod, pretty in dev, redaction always on

Registered as the app logger (`app.useLogger(app.get(Logger))`) with `bufferLogs: true`, so framework boot logs land in the same stream and format. `pino-http` auto-logs request completion with method, path, status, and duration.

- `LOG_LEVEL` from validated config; `pino-pretty` transport only when `NODE_ENV !== 'production'` (it is a devDependency and must never be required in the production image).
- **Redaction is not optional and not per-call-site:** `redact` covers `req.headers.authorization`, `req.headers.cookie`, `req.headers["set-cookie"]`, and `*.password`/`*.token`/`*.secret`/`*.apiKey` paths. A test asserts a token in a header does not appear in serialized output — cheap, and the class of bug it catches is expensive.
- `customProps` injects `requestId` from `RequestContext` into every line.
- Health-check routes are excluded from auto-logging (`autoLogging.ignore`) — a readiness probe every 5s otherwise dominates the log volume.
- **Rejected:** Winston — Pino's transports are process-boundary-based, which is what makes production logging cost near-zero, and `nestjs-pino` is the better-maintained Nest integration.

### 7. Terminus, with `/health/live` and `/health/ready` meaning genuinely different things

- `GET /health/live` — returns 200 if the process is running. **Zero dependency checks.** A liveness probe that checks the database restarts the app when the database blips, turning a dependency outage into a crash loop.
- `GET /health/ready` — checks Postgres (`PrismaHealthIndicator.pingCheck`) and Redis (custom indicator built on Terminus 11's `HealthIndicatorService`, issuing `PING` with a short timeout). Returns 503 when a dependency is unreachable, so the orchestrator stops routing traffic without killing the pod.

Both are `@NoEnvelope()`. Both are excluded from request logging. The Redis indicator is custom because Terminus ships no first-class ioredis check; it is ~30 lines and lives in `infrastructure/health/`.

### 8. Prisma 7: `PrismaService extends PrismaClient`, driver adapter, connect on init

> Revised during implementation. Prisma resolved to **7.9.1**, which changed three things this design originally assumed (Prisma 6 semantics). Verified directly against the package, not from documentation.

**A driver adapter is mandatory.** `new PrismaClient()` with no arguments throws (`A driver adapter is required to connect to your database`), and the `datasourceUrl` constructor option was removed. `PrismaService` constructs `PrismaPg` from `@prisma/adapter-pg` with the connection string taken from the validated `database` config namespace:

```ts
super({ adapter: new PrismaPg({ connectionString: databaseConfig.url }) });
```

This is strictly better for us than the original `url = env("DATABASE_URL")` in `schema.prisma`: the connection string now flows through the same validated config as everything else, rather than Prisma reading `process.env` behind our backs — which the ESLint rule in Decision 1 exists to prevent.

**The `prisma-client` generator, emitting CJS into `src/`.** `prisma-client-js` still works in 7.x but is deprecated and slated for removal in Prisma 8; a template should not ship its forks a known migration. The modern generator emits TypeScript sources rather than a prebuilt client, so it is configured to land somewhere the build already compiles:

```prisma
generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  moduleFormat        = "cjs"
  runtime             = "nodejs"
  importFileExtension = ""
}
```

`moduleFormat = "cjs"` drops the `import.meta.url` preamble that would break under CommonJS. `importFileExtension = ""` emits **extensionless** cross-file imports (`./enums`), which is the setting that works across every consumer at once:

| Consumer | `"js"` (first attempt) | `""` (chosen) |
| --- | --- | --- |
| `tsc` / SWC build | resolves | resolves |
| `dist` at runtime | resolves | resolves |
| **ts-node** (seed script) | **fails** — `Cannot find module './internal/class.js'`; only `.ts` files exist on disk, and the runtime require hook resolves the literal specifier | resolves |
| ts-jest | needs a `moduleNameMapper` workaround | resolves |

TypeScript's `.js` → `.ts` mapping is a *type-level* resolution rule; it does not help a CommonJS `require` at runtime. Extensionless specifiers sidestep the split entirely, because Node's CJS resolver appends `.js` in `dist` while ts-node/ts-jest resolve `.ts` from source.

Output under `src/generated/` is what makes `nest build` compile the client into `dist/` — outside `src/`, it would be absent at runtime. The cost is that generated code sits in `src/`, so it is excluded from lint, coverage, and typecheck-by-convention, and gitignored.

**`prisma.config.ts` replaces the `package.json` `prisma` key**, carrying `schema`, `migrations.path`, `migrations.seed`, and `datasource.url`. It is one of the two files permitted to read `process.env` (alongside `src/config/**`), since it runs as CLI tooling outside the Nest container.

`onModuleInit` calls `$connect()` so a bad `DATABASE_URL` surfaces at boot rather than on first request. Disconnect rides `app.enableShutdownHooks()` and `OnModuleDestroy` — **not** Prisma's `beforeExit` hook, which was removed for the library engine in Prisma 5+.

Baseline schema carries exactly one model:

```prisma
model AppSetting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt
}
```

- It gives the seed hook something idempotent and real to do (`upsert` a `seed_version` marker), which is what makes the seed *pattern* verifiable rather than aspirational.
- It gives integration tests a genuine round-trip (write → read → assert) instead of `SELECT 1`.
- It does **not** collide with Better Auth's generated `User`/`Session`/`Account`/`Verification` models. Creating a placeholder `User` now would guarantee a conflicting migration in the auth change; this avoids it.

Migrations are committed under `prisma/migrations/`. `prisma db seed` is wired through `migrations.seed` in `prisma.config.ts`, running `prisma/seed.ts` under `ts-node` with `tsconfig-paths` registered. Seeds are idempotent (`upsert`, never `create`) so re-running against a populated dev database is safe.

The Prisma files are hand-written rather than produced by `prisma init`, which in 7.x also scaffolds `.claude/skills/`, `.agents/skills/`, `.windsurf/skills/`, and `skills-lock.json` into the repo root — unrelated to this change and not something the starter should carry.

### 9. Path aliases: tsconfig is the source of truth, everything else derives or is smoke-tested

`tsconfig.json` declares `@/*` → `src/*` plus `@common/*`, `@config/*`, `@infrastructure/*`, `@modules/*`.

| Consumer | Mechanism |
| --- | --- |
| `tsc --noEmit` (typecheck) | `paths` directly |
| SWC (`nest build`) | `jsc.baseUrl` + `jsc.paths` in `.swcrc` — SWC rewrites specifiers to relative at transpile time |
| Jest | `pathsToModuleNameMapper(compilerOptions.paths)` — derived, not duplicated |
| ts-node (`prisma/seed.ts`) | `tsconfig-paths/register` (already a devDependency) |
| `node dist/main` | nothing needed — SWC already rewrote them |

`.swcrc` is the one place aliases are genuinely duplicated. The mitigation is a CI step that boots the built artifact (`node dist/main` → poll `/health/live` → exit), because a broken alias rewrite passes lint, typecheck, and unit tests and fails only at runtime. That smoke test is the actual guard; the rest is bookkeeping.

- **Rejected:** Node subpath imports (`#common/*` via `package.json` `imports`) — zero build config, but unfamiliar in the Nest ecosystem and awkward for a template people will copy from.
- **Rejected:** `tsc-alias` post-build — an extra dependency solving a problem SWC does not have.

### 10. Multi-stage `Dockerfile` on `node:22-alpine`, Compose for the local stack

Stages: `base` (corepack + pnpm) → `deps` (`--frozen-lockfile`) → `build` (`prisma generate` + `nest build`) → `runner` (prod deps + `dist/`, non-root `node` user, `--init` for signal handling).

- **Alpine, revised during implementation.** The original rationale for `bookworm-slim` was Prisma's Rust query engine and the `linux-musl-openssl-3.0.x` binary-target footgun. Prisma 7 ships a **WASM query compiler with no native engine binary**, so that failure mode no longer exists and the smaller image wins. The trade-off that remains is musl vs glibc for native dependencies a *fork* might add later (`bcrypt`, `sharp`) — documented in the README so a fork knows why the base image is what it is and when to change it.
- `prisma generate` runs in `build`; because the client is generated into `src/generated/`, `nest build` compiles it into `dist/` and the runtime image needs neither the `prisma` CLI nor a separate copy step.
- `compose.yaml` runs `app` (built from `runner`), `postgres:17-alpine`, `redis:7-alpine`, each dependency with a healthcheck (`pg_isready`, `redis-cli ping`) and `depends_on: { condition: service_healthy }` — so `up` does not race the app against an unready database. Named volumes for Postgres data.
- `compose.dev.yaml` overlays the `build` stage with a source bind mount and `pnpm start:dev` for hot reload. Same file set, two modes, one Dockerfile.
- Migrations are **not** run from the container entrypoint. Auto-migrating on boot means N replicas racing the same migration; `pnpm db:migrate` is an explicit step, documented in the README.

### 11. CI: one job, real services, ordered cheapest-first

GitHub Actions on push and PR: pnpm + Node 22 with cache → install → `prisma generate` → lint → typecheck → unit tests → `prisma migrate deploy` → e2e tests → `nest build` → boot smoke test → `docker build`.

Postgres and Redis run as service containers with health options, so integration and e2e tests hit real engines. Ordering is deliberate: lint and typecheck fail in seconds and catch most PRs before the expensive steps run.

- Single Node version, not a matrix. This is an application template, not a library — it declares one supported runtime.
- `--frozen-lockfile` everywhere; a lockfile drift is a CI failure, not a silent resolution.

### 12. Global `/api` prefix with URI versioning, health outside both

`main.ts` sets `setGlobalPrefix('api', { exclude: ['health/(.*)'] })` and `enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`, so application routes resolve at `/api/v1/...` while probes stay at `/health/live` and `/health/ready`.

Fixed now rather than later because every queued change hardcodes paths against whatever the answer is, and introducing a prefix afterwards breaks every fork that already built on the starter. Health sits outside the prefix so an orchestrator's probe configuration survives an eventual `v2`.

- **Why URI versioning over header or media-type versioning:** it is greppable, cacheable, trivially testable with `curl`, and the default a fork will expect. Header versioning is cleaner in principle and worse in practice for a template.
- `defaultVersion: '1'` means controllers need no `@Version()` decorator until a second version exists.

## Risks / Trade-offs

**`forbidNonWhitelisted` will reject payloads the app does not model** → Correct default for a first-party API, wrong for third-party webhooks. Mitigated by documenting the raw-body + pipe-bypass path for webhook routes here, before the Stripe change needs it.

**`enableImplicitConversion` coerces aggressively** — `?limit=abc` becomes `NaN`, not a type error → Mitigated by requiring explicit `class-validator` decorators on every query/param DTO; the pipe converts, the validators reject. Called out in the DTO conventions the specs pin down.

**Client-supplied `x-request-id` is untrusted input** — an attacker can send anything, including log-injection payloads or a 10 KB string → Mitigated by validating against a strict pattern (UUID or ≤64 chars of `[A-Za-z0-9_-]`) and regenerating on mismatch. Never used for authorization, cache keys, or anything but correlation.

**ALS has a real (small) cost and is easy to lose across manual `Promise` boundaries** → Accepted: the alternative is request-scoped providers, whose cost is larger and whose failure mode (silent per-request re-instantiation of the injection subtree) is harder to notice. Standard `async/await` preserves the store; the pattern to avoid — detaching work with a bare `.then()` outside the request — is documented.

**Aliases duplicated across `tsconfig.json` and `.swcrc` can drift** → The boot smoke test in CI is the guard; a drift that survives typecheck fails there loudly.

**Prisma + SWC decorator metadata** — SWC's `decoratorMetadata` must be enabled or DI silently resolves `undefined` for typed constructor params → `nest-cli.json` already sets `typeCheck: true`; `.swcrc` explicitly enables `jsc.transform.legacyDecorator` and `decoratorMetadata`. An e2e test that boots the full app catches this class of failure immediately.

**Postgres and Redis become hard local prerequisites** — contributor friction on first clone → Mitigated by `docker compose up` being the documented single command, and by `/health/ready` reporting *which* dependency is down rather than a generic failure.

**The envelope is a breaking API contract for forks that already diverged** → Accepted; the repo has no released consumers, and `@NoEnvelope()` is the escape hatch.

**Baseline `AppSetting` model may read as speculative** → It is the minimum that makes the seed hook and persistence tests real rather than decorative, and it is one table a fork can delete in one migration.

## Migration Plan

No data migration — there is no deployed instance and no released consumer. The ordering below exists so the app boots and tests pass at every step, rather than a big-bang restructure:

1. Toolchain first: path aliases across `tsconfig` / `.swcrc` / Jest / ts-node, Node pin, scripts. Doing this ahead of the code means nothing written later needs its imports rewritten.
2. Config + folder skeleton (`app.module.ts` composes; nothing behavioral yet).
3. Request context + logger.
4. Routing prefix, validation pipe, envelope interceptor, exception filter — the app now has its contract; scaffolded controller/service deleted here.
5. Prisma + Postgres, migration, seed hook.
6. Redis client + health checks (readiness needs both step 5 and this one).
7. Docker Compose + Dockerfile.
8. CI workflow + boot smoke test.
9. README.

**Rollback:** revert the commit. If migrations reached a shared database, `prisma migrate resolve --rolled-back <migration>` before re-applying — documented in the README's database section.

## Open Questions

**Resolved during design:**

1. ~~Global API prefix and versioning~~ → **Resolved: `/api/v1` with URI versioning, health excluded.** See Decision 12; the proposal's scope was widened to match.
2. ~~Node version pin~~ → **Resolved: Node 22 LTS**, pinned in the Dockerfile, the CI workflow, and `engines` in `package.json`.

**Still open:**

3. **Redis client.** `ioredis` chosen because the queued throttling work (`@nest-lab/throttler-storage-redis`, BullMQ) expects it. If throttling ends up on a different storage adapter, revisit — but the readiness indicator is the only consumer in this change, so the cost of changing later is one file. Not blocking.
