## Why

The repo is currently a bare `nest new` scaffold: a single `AppModule`, no config validation, no database, no logging, no response contract. Every planned feature — Better Auth, RBAC, plans/entitlements, Redis throttling, usage limits, the credit ledger, Stripe, admin monitoring — needs the same substrate, and each one will encode assumptions about config access, error shape, request correlation, and persistence the moment it is written.

Building that substrate first, once, is cheaper than retrofitting it across seven feature modules later. It also makes the starter usable as a starter: someone who forks the repo at the end of this change gets a running, containerized, observable, database-backed NestJS service with a stable API contract, before any product logic exists.

## What Changes

- **Folder layout**: reorganize `src/` into `common/` (cross-cutting pipes, filters, interceptors, decorators, DTOs), `config/` (env schema and typed config namespaces), `infrastructure/` (Prisma, Redis, logger — technical adapters), and `modules/` (feature modules). Replace the scaffolded `app.controller.ts` / `app.service.ts` demo files.
- **Validated configuration**: a Zod schema validates `process.env` at boot and the app refuses to start on invalid or missing values, reporting every failure at once rather than the first. Config is exposed through `@nestjs/config` as typed namespaces; direct `process.env` reads outside `config/` are banned by lint rule. Ships a complete `.env.example`.
- **Global validation pipe**: `ValidationPipe` registered globally with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, and implicit conversion for path/query params, so every endpoint validates and strips input by default rather than opting in.
- **API routing contract**: application routes are served under a global `/api` prefix with URI versioning (`/api/v1/...`), fixed now because every later change hardcodes paths against it and retrofitting a prefix is breaking. `/health/*` sits outside the prefix so orchestrator probe paths stay stable across API versions.
- **Uniform response envelope**: a success interceptor wraps all handler returns in `{ success, data, meta }`, and a global exception filter maps every thrown error — `HttpException`, Prisma known errors, and unexpected throws — to `{ success: false, error: { code, message, details }, meta }`. Both carry a `requestId` generated or propagated per request via `AsyncLocalStorage`, so a client-reported ID maps to log lines.
- **Structured logging**: `nestjs-pino` replaces the default Nest logger. JSON in production, pretty-printed in development, with automatic redaction of `authorization`, `cookie`, and credential-bearing fields. Request/response logs are auto-emitted and carry `requestId`.
- **Health checks**: `@nestjs/terminus` exposes `GET /health/live` (process is up, no dependency checks) and `GET /health/ready` (Postgres and Redis reachable), both excluded from the response envelope so orchestrators get the shape they expect.
- **Persistence**: Prisma + PostgreSQL with a `PrismaService` bound to Nest's lifecycle, an initial migration, a `prisma/seed.ts` hook wired to `prisma db seed`, and a baseline schema carrying only what the foundation needs.
- **Docker Compose**: `app`, `postgres`, and `redis` services with healthchecks and named volumes, plus a multi-stage `Dockerfile` (deps → build → slim runtime) so the same image serves local and production.
- **Path aliases + CI**: `@/*` (and per-directory aliases) resolved consistently across `tsc`, SWC, Jest, and runtime; GitHub Actions runs lint, typecheck, test, and build on push and PR, with Postgres and Redis service containers for integration tests.

### Non-goals

- **No authentication, RBAC, or session handling.** No Better Auth wiring, no guards, no `User` model beyond what persistence smoke tests need. The envelope and config substrate are built so auth can slot in, not built with auth in mind.
- **No billing, plans, entitlements, credits, or Stripe.** No ledger tables, no plan enum, no webhook endpoints.
- **No throttling or usage limits.** Redis is provisioned in Compose and health-checked, and a connection is established, but no rate-limit guard, no counters, no quota logic. That is a later change that will consume this Redis client.
- **No admin monitoring APIs**, no OpenAPI/Swagger generation, no metrics/tracing exporters. Structured logging is the only observability in scope.
- **No deployment targets.** No Kubernetes manifests, no cloud provisioning, no release pipeline — CI verifies, it does not ship.

## Capabilities

### New Capabilities

- `app-configuration`: Fail-fast environment validation at boot, typed config access through namespaced providers, and a documented `.env.example` contract for every variable the app reads.
- `request-validation`: Global DTO validation and transformation — unknown properties rejected, payloads coerced to their declared types, and validation failures surfaced as structured field-level errors.
- `api-response-envelope`: The uniform HTTP contract — a versioned `/api/v1` routing surface, a single success and error response shape across every endpoint, a global exception filter that leaks no internals, and per-request correlation IDs propagated to responses and logs.
- `structured-logging`: JSON structured logging with request correlation, environment-appropriate formatting, and redaction of sensitive fields.
- `health-checks`: Liveness and readiness endpoints with distinct semantics, readiness gated on Postgres and Redis reachability.
- `data-persistence`: Prisma-managed PostgreSQL access with lifecycle-bound connections, versioned migrations, and an idempotent seed hook.
- `developer-environment`: One-command local stack via Docker Compose, consistent path-alias resolution across every toolchain, and CI gates on lint, typecheck, test, and build.

### Modified Capabilities

None — `openspec/specs/` is empty; this change establishes the first specs.

## Impact

**Code**
- `src/` restructured; scaffolded `app.controller.ts`, `app.service.ts`, and `app.controller.spec.ts` removed. **BREAKING** for anyone who has already forked, but the repo has no released consumers.
- `src/main.ts` rewritten to bootstrap the logger, global pipe, filter, interceptor, graceful shutdown hooks, and a validated port.

**APIs**
- **BREAKING**: all responses gain the envelope wrapper, and all application routes move under `/api/v1`. `GET /` (the scaffolded `"Hello World!"`) is removed. New: `GET /health/live`, `GET /health/ready` — both outside the prefix and outside the envelope.

**Dependencies added**
- Runtime: `@nestjs/config`, `zod`, `class-validator`, `class-transformer`, `nestjs-pino`, `pino`, `pino-http`, `@nestjs/terminus`, `@prisma/client`, `ioredis`
- Dev: `prisma`, `pino-pretty`, `@types/*` as needed

**Systems**
- PostgreSQL and Redis become required runtime dependencies — the app will not pass readiness without them. Contributors need Docker (or local instances) to run the service and the integration tests.
- CI gains service containers, lengthening pipeline runtime.

**Downstream changes** inherit config access, the error envelope, the logger, and `PrismaService` from this change, and must not reintroduce parallel mechanisms for any of them.
