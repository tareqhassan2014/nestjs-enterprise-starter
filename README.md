# NestJS Enterprise Starter

An opinionated NestJS 11 starter with the cross-cutting substrate already built: validated configuration, a uniform API contract, structured logging with request correlation, health checks, Prisma + PostgreSQL, Redis, Docker, and CI.

Fork it and build features on top — the parts every service needs are decided and wired.

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
| Local stack | Docker Compose: app + Postgres + Redis, with healthchecks |
| CI | GitHub Actions: lint, typecheck, unit, integration, build, boot smoke test, image build |

Not included by design: authentication, RBAC, billing, plans, credits, and throttling. Those are separate changes that build on this foundation.

## Requirements

- Node.js 22+
- pnpm 11+ (`corepack enable`)
- Docker (for Postgres and Redis)

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm docker:up          # app + Postgres + Redis
```

Then:

```bash
curl http://localhost:3000/health/ready
```

If port 5432, 6379, or 3000 is already taken on your machine, set the host port in `.env` — only the host side moves, since the app reaches `postgres:5432` on the Compose network regardless:

```bash
POSTGRES_HOST_PORT=5433
REDIS_HOST_PORT=6380
APP_HOST_PORT=3001
```

These are read by Docker Compose, not by the application, so they are deliberately absent from `.env.example` and the env schema.

### Running the app outside Docker

```bash
cp .env.example .env
pnpm install
pnpm docker:up postgres redis   # data services only
pnpm db:generate
pnpm db:migrate
pnpm start:dev
```

`prisma generate` is required before the first typecheck or build: the client is generated into `src/generated/` (gitignored), and the build compiles it into `dist/`.

### Hot reload inside Docker

```bash
pnpm docker:up:dev
```

Mounts `src/` into the container and runs `start:dev`.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm start:dev` | Watch mode |
| `pnpm build` | Compile to `dist/` (SWC, with typecheck) |
| `pnpm typecheck` | `tsc --noEmit` across src, tests, and scripts |
| `pnpm lint` / `lint:ci` | ESLint, with and without `--fix` |
| `pnpm test` | Unit tests |
| `pnpm test:e2e` | End-to-end and integration tests (needs Postgres + Redis) |
| `pnpm test:smoke` | Boots `dist/main`, checks liveness, asserts clean SIGTERM exit |
| `pnpm check:env` | Fails if `.env.example` and the env schema have drifted |
| `pnpm db:generate` | Generate the Prisma client |
| `pnpm db:migrate` | Create and apply a migration (development) |
| `pnpm db:migrate:deploy` | Apply pending migrations (CI, production) |
| `pnpm db:seed` | Run the idempotent seed |
| `pnpm db:reset` | Drop, re-migrate, and re-seed |
| `pnpm db:studio` | Prisma Studio |
| `pnpm docker:up` / `:dev` / `docker:down` | Compose stack |

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
  infrastructure/   # technical adapters: prisma/, redis/, logger/, health/
  modules/          # feature modules — yours go here
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

Clients branch on `error.code`, not the HTTP status. Current codes: `VALIDATION_FAILED`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`. Codes are additive — never rename one.

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

Errors thrown from an exempt handler still use the error envelope. The health endpoints are the sole exception — orchestrators need the Terminus payload even on failure.

### Third-party webhooks

The global pipe uses `forbidNonWhitelisted`, so a payload carrying fields you do not model is a `400`. That is the right default for a first-party API and the wrong one for, say, Stripe. Webhook routes need the raw body and must bypass the global pipe at the route level (`@Body()` with a raw-body parser and a per-route `@UsePipes()` override), plus `@NoEnvelope()` if the sender expects a specific response shape.

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

Integration tests run against real Postgres and Redis, not mocks — that is what makes the health checks, Prisma error mapping, and shutdown behavior meaningful.

## Docker

Multi-stage build on `node:22-alpine`: `deps` → `prod-deps` → `build` → `runner`. The runtime image carries production dependencies and `dist/` only — no sources, no dev dependencies, non-root `node` user, `init: true` for signal handling.

Alpine is safe here because Prisma 7 ships a WASM query compiler with no native engine binary; the musl/OpenSSL binary-target problem that made Alpine risky under Prisma 6 no longer applies. If you add native dependencies (`bcrypt`, `sharp`), consider switching the base image to `node:22-bookworm-slim`.

## CI

`.github/workflows/ci.yml` runs on push and pull request with Postgres and Redis service containers: install (frozen lockfile) → generate → env drift check → lint → typecheck → unit tests → migrate → e2e → build → boot smoke test → image build. Cheap gates run first.

The boot smoke test exists because path aliases are declared in `tsconfig.json` and mirrored in `.swcrc`; a drift between them passes lint, typecheck, and every test, and fails only when the built output actually runs.

## Conventions

- Read configuration through the typed namespaces in `src/config/`. `process.env` outside that directory is a lint error.
- Handlers return payloads, not envelopes.
- Every query and param DTO carries explicit `class-validator` decorators — implicit conversion coerces types but does not reject them.
- Use `PrismaService`; do not instantiate a second client.
- Seeds use `upsert`, never `create`.

## Specs

Planning artifacts live in `openspec/`. This foundation was built from `openspec/changes/add-platform-foundation/`, whose `design.md` records why each decision was made and what was rejected.

## License

MIT.
