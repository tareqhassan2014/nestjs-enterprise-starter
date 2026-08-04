## 1. Toolchain and project skeleton

- [x] 1.1 Add runtime dependencies: `@nestjs/config`, `zod`, `class-validator`, `class-transformer`, `nestjs-pino`, `pino`, `pino-http`, `@nestjs/terminus`, `@prisma/client`, `@prisma/adapter-pg`, `ioredis`
- [x] 1.2 Add dev dependencies: `prisma`, `pino-pretty`, `dotenv` (for `prisma.config.ts`); allow `prisma` / `@prisma/engines` builds in `pnpm-workspace.yaml`; set `engines.node` to `>=22` (Docker and CI pin 22 exactly; a hard `<23` ceiling would break local dev on Node 24)
- [x] 1.3 Declare path aliases in `tsconfig.json` (`@/*`, `@common/*`, `@config/*`, `@infrastructure/*`, `@modules/*`) with **relative targets and no `baseUrl`** — TypeScript 5.9 deprecates `baseUrl` (removed in 7.0), and TS 5.0+ resolves `paths` against the tsconfig's own directory
- [x] 1.4 Add `.swcrc` mirroring the aliases in `jsc.baseUrl` / `jsc.paths`, with `legacyDecorator` and `decoratorMetadata` enabled
- [x] 1.5 Point Jest's `moduleNameMapper` at the tsconfig paths via `pathsToModuleNameMapper`, reading the tsconfig through `ts.readConfigFile` (a JSON `import` fails under Node's ESM loader without an import attribute); configs move to `jest.config.ts` and `test/jest-e2e.config.ts`, since the old JSON configs cannot derive anything
- [x] 1.6 Create the directory skeleton: `src/common/`, `src/config/`, `src/infrastructure/`, `src/modules/`, each with a `.gitkeep` until populated
- [x] 1.7 Add scripts: `db:generate`, `db:migrate`, `db:migrate:deploy`, `db:seed`, `db:reset`, `db:studio`, `check:env`, `test:e2e`, `test:smoke`, `docker:up`, `docker:up:dev`, `docker:down`, `docker:logs`
- [x] 1.8 Verify `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, and `pnpm build` still pass on the untouched scaffold

## 2. Configuration layer

- [x] 2.1 Write `src/config/env.schema.ts` — Zod schema covering `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, with `z.coerce` for numerics and no defaults on secrets or connection strings
- [x] 2.2 Implement the `validate` function that `safeParse`s and, on failure, throws one error aggregating every issue with variable name and expected shape
- [x] 2.3 Add `registerAs` namespaces `app`, `database`, `redis`, `logger` deriving from the validated env, each exporting its `ConfigType`
- [x] 2.4 Register `ConfigModule.forRoot({ isGlobal: true, validate, cache: true })` in `AppModule`
- [x] 2.5 Rewrite `src/main.ts` to read the port from the `app` namespace instead of `process.env`
- [x] 2.6 Add the ESLint `no-restricted-properties` rule banning `process.env` outside `src/config/**` and `prisma/**`
- [x] 2.7 Write `.env.example` with every schema variable, a purpose comment per line, Compose-compatible non-secret defaults, and placeholders for secrets
- [x] 2.8 Add `scripts/check-env-example.ts` (or equivalent) asserting `.env.example` and the schema declare the same variable set; wire it to a `check:env` script
- [x] 2.9 Tests: valid env passes; two simultaneously invalid vars are both reported in one error; unknown extra vars are ignored; `PORT="8080"` surfaces as the number `8080`; missing `DATABASE_URL` fails

## 3. Request context

- [x] 3.1 Implement `src/common/context/request-context.ts` — `AsyncLocalStorage<RequestContextStore>` with a typed store (`{ requestId: string }`) and static `getRequestId()` / `run()` helpers
- [x] 3.2 Implement `RequestContextMiddleware`: validate inbound `x-request-id` against the accepted pattern (UUID, or ≤64 chars of `[A-Za-z0-9_-]`), fall back to `randomUUID()`, and open the ALS scope
- [x] 3.3 Set the `x-request-id` response header from the resolved identifier
- [x] 3.4 Apply the middleware to all routes in `AppModule`, ordered ahead of the logger middleware
- [x] 3.5 Tests: generated when absent; propagated when valid; regenerated (not rejected) when malformed or oversized; readable from a nested async call stack

## 4. Structured logging

- [x] 4.1 Register `LoggerModule.forRootAsync` (nestjs-pino) with level from the `logger` config namespace
- [x] 4.2 Configure the `pino-pretty` transport only when `NODE_ENV !== 'production'`, ensuring it is never resolved in the production image
- [x] 4.3 Configure `redact` for `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, and `*.password` / `*.token` / `*.secret` / `*.apiKey`
- [x] 4.4 Set `customProps` to inject `requestId` from `RequestContext`, and `genReqId` to reuse the same value
- [x] 4.5 Exclude `/health/live` and `/health/ready` from `autoLogging`
- [x] 4.6 Set `bufferLogs: true` and `app.useLogger(app.get(Logger))` in `main.ts` so bootstrap logs share the format
- [x] 4.7 Tests: production output is one line of valid JSON per entry; an `authorization: Bearer <token>` value never appears in serialized output; a logged `password` property is redacted; a log from a nested service carries the request's `requestId`; readiness probes emit no completion log

## 5. HTTP contract — routing, validation, envelope, errors

- [x] 5.1 In `main.ts`, set `setGlobalPrefix('api', { exclude: [...health routes] })` and `enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`
- [x] 5.2 Define the error code enum in `src/common/errors/` (`VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL_ERROR`) and the `ApiError` / envelope response types
- [x] 5.3 Register the global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform`, and `enableImplicitConversion`
- [x] 5.4 Add the `exceptionFactory` flattening validation failures into `details: [{ field, constraint, message }]`, with dotted paths for nested fields
- [x] 5.5 Implement `ResponseEnvelopeInterceptor` wrapping handler returns as `{ success: true, data, meta: { requestId, timestamp } }`, mapping `undefined` returns to `data: null`
- [x] 5.6 Implement the `@NoEnvelope()` metadata decorator and have the interceptor skip marked handlers via `Reflector`
- [x] 5.7 Implement `AllExceptionsFilter` covering `HttpException`, `PrismaClientKnownRequestError`, and unknown throws; log non-HTTP errors at `error` with stack and `requestId`; never emit stack or raw error text in the body
- [x] 5.8 Map `P2002` → `409 CONFLICT` and `P2025` → `404 NOT_FOUND` in the filter, with unmapped database errors falling through to `INTERNAL_ERROR`
- [x] 5.9 Register the interceptor and filter globally via `APP_INTERCEPTOR` / `APP_FILTER` providers
- [x] 5.10 Document the raw-body/webhook bypass path (comment plus README note) for routes that must accept unmodeled payloads
- [x] 5.11 Delete `src/app.controller.ts`, `src/app.service.ts`, and `src/app.controller.spec.ts`; reduce `AppModule` to composition only
- [x] 5.12 Tests (e2e): object, array, and void returns produce the correct envelope; unknown body property yields `400 VALIDATION_FAILED` naming it; `?page=abc` fails while `?page=2` yields a number; a thrown `Error` returns generic `500 INTERNAL_ERROR` with no stack or original message in the body while the log carries both; a `@NoEnvelope()` handler returns a bare body but still errors through the envelope; `meta.requestId` matches the `x-request-id` header
- [x] 5.13 Tests (e2e): a controller path resolves at `/api/v1/<path>` and returns `404` unprefixed

## 6. Persistence

- [x] 6.1 Hand-write `prisma/schema.prisma` (not `prisma init`, which also scaffolds agent-skill directories) with the `prisma-client` generator: `output = "../src/generated/prisma"`, `moduleFormat = "cjs"`, `runtime = "nodejs"`, `importFileExtension = "js"`; gitignore the generated directory and exclude it from lint and coverage
- [x] 6.2 Define the baseline `AppSetting` model (`key` PK, `value` Json, `updatedAt`) — no auth, billing, plan, or credit models
- [x] 6.3 Implement `PrismaService extends PrismaClient`, passing a `PrismaPg` adapter built from the `database` config namespace (Prisma 7 requires an adapter); `$connect()` in `onModuleInit`, `$disconnect()` in `onModuleDestroy`; do not use the removed `beforeExit` hook
- [x] 6.3a Write `prisma.config.ts` with `schema`, `migrations.path`, `migrations.seed`, and `datasource.url`; permit `process.env` there via the ESLint override
- [x] 6.4 Create `PrismaModule` (global) exporting `PrismaService`
- [x] 6.5 Generate the initial migration and commit `prisma/migrations/`
- [x] 6.6 Write `prisma/seed.ts` upserting a `seed_version` marker; wire it through `migrations.seed` in `prisma.config.ts`, running under `ts-node` with `tsconfig-paths/register`
- [x] 6.7 Call `app.enableShutdownHooks()` in `main.ts`
- [x] 6.8 Tests: write-then-read round trip on `AppSetting`; seed run twice exits `0` with no duplicates and no unique-constraint error; bootstrap against an unreachable `DATABASE_URL` exits non-zero with a connection error
- [x] 6.9 Confirm no migration runs automatically at application startup

## 7. Redis and health checks

- [x] 7.1 Implement `RedisModule` providing a configured `ioredis` client from the `redis` namespace, closing the connection on module destroy
- [x] 7.2 Implement `RedisHealthIndicator` on Terminus 11's `HealthIndicatorService`, issuing `PING` with a short timeout
- [x] 7.3 Implement `HealthController` with `GET /health/live` (no dependency checks) and `GET /health/ready` (Prisma `pingCheck` + Redis indicator), both marked `@NoEnvelope()`
- [x] 7.4 Register `TerminusModule` and confirm both routes are excluded from the global prefix
- [x] 7.5 Tests (e2e): liveness returns `200` while Postgres and while Redis are unreachable; readiness returns `503` naming the specific failing dependency; readiness returns `200` when both are up; a hung dependency fails on timeout rather than hanging the probe
- [x] 7.6 Test: `SIGTERM` closes Prisma and Redis connections and exits `0` after in-flight requests complete

## 8. Docker

- [x] 8.1 Write the multi-stage `Dockerfile` on `node:22-alpine` — `base` (corepack/pnpm) → `deps` (`--frozen-lockfile`) → `build` (`prisma generate` + `nest build`) → `runner`
- [x] 8.2 In `runner`: production dependencies plus `dist/` only (the generated client compiles into `dist/`), non-root `node` user, `--init` for signal handling, no `prisma` CLI
- [x] 8.3 Add `.dockerignore` excluding `node_modules`, `dist`, `.git`, `.env`, and `coverage`
- [x] 8.4 Write `compose.yaml` with `app` (from `runner`), `postgres:17-alpine`, and `redis:7-alpine`; healthchecks via `pg_isready` and `redis-cli ping`; `depends_on: { condition: service_healthy }`; named volume for Postgres data
- [x] 8.5 Write `compose.dev.yaml` overlaying the `build` stage with a source bind mount and `pnpm start:dev`
- [x] 8.6 Confirm no migration runs from the container entrypoint
- [x] 8.7 Verify: `.env.example` copied unedited to `.env` → stack up → `/health/ready` returns `200`; stop/start preserves Postgres data; `docker stop` exits cleanly without force-kill; the runtime image contains no dev dependencies or `.ts` sources

## 9. CI

- [x] 9.1 Add `.github/workflows/ci.yml` triggered on push and pull request, on Node 22 with pnpm and dependency caching
- [x] 9.2 Add Postgres and Redis service containers with health options
- [x] 9.3 Order the steps: install (`--frozen-lockfile`) → `prisma generate` → `check:env` → lint → typecheck → unit tests → `prisma migrate deploy` → e2e tests → build
- [x] 9.4 Add the boot smoke test: start `node dist/main`, poll `/health/live` until healthy or timeout, then shut down — the guard against `.swcrc` alias drift
- [x] 9.5 Add a `docker build` step verifying the production image builds
- [x] 9.6 Verify the pipeline fails on an intentionally introduced lint error, and that a `package.json` dependency missing from the lockfile fails installation rather than resolving silently

## 10. Documentation and close-out

- [x] 10.1 Rewrite the README: first-run setup, Compose commands, script reference, and the `/api/v1` + `/health/*` routing contract
- [x] 10.2 Document the database workflow — create a migration, apply, seed, reset, and `prisma migrate resolve --rolled-back` for a shared database
- [x] 10.3 Document the response envelope and error-code contract, including `@NoEnvelope()` and the webhook raw-body bypass
- [x] 10.4 Run the full local gate (`lint`, `typecheck`, `test`, `test:e2e`, `build`, Compose up → `/health/ready`) and confirm every task above is checked
