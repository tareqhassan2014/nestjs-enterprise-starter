## Context

Commercial and security layers already ship: Better Auth + RBAC, Lite/Pro plans and subscriptions, Redis throttle + usage limits, per-user credit wallets/ledger, Stripe top-up, admin APIs, and Nest-hosted MCP. Foundation pieces the starter still lacks are the ones every fork reinvents poorly: background jobs, object storage, runtime feature toggles, safe HTTP retries, org-scoped billing hooks, and shutdown that drains workers—not only HTTP.

Constraints:

- **Redis already exists** (throttle, usage, sessions-adjacent). BullMQ must share Redis carefully (key prefix isolation) without breaking existing counter TTLs.
- **Transactional email port already exists** (`transactional-email`). Do not invent a second mail API; queue sits behind/beside that port.
- **Credits and subscriptions are user-primary today** (`CreditWallet.userId`, `Subscription` → user). Org-primary is additive via a billing-subject resolver, not a forced migration of all rows.
- **Usage limits already reserve an org key dimension** — org membership + context binding finally gives that dimension a real subject.
- **Guard order is sacred:** auth → RBAC → entitlements → throttle → usage → credits. Idempotency and flags wrap/annotate; they do not reorder gates.
- **Template ethos:** small modules a fork can delete; config validated at boot; no secrets in git.

## Goals / Non-Goals

**Goals:**

- One BullMQ-backed queue module with named queues for email, outbound webhooks, and usage rollups.
- Storage and feature-flag ports that application code depends on instead of SDKs/env scattering.
- Opt-in HTTP idempotency for critical POSTs with conflict detection on key reuse.
- Minimal organizations + membership + `BillingSubject` resolver so credits/plans can be org-primary when context says so.
- Graceful shutdown that drains HTTP and workers within a configured timeout, then closes Prisma/Redis/BullMQ/storage.
- Wire low-balance (and similar) signals to enqueue email when flags/config allow — without making mail sync-blocking on the request path by default.

**Non-Goals:**

- Full tenancy product (invites UI, SSO-per-org, custom domains).
- Migrating existing user wallets/subscriptions to org ownership in one cut.
- Inbound generic webhook product or replacing Stripe webhook handling.
- LaunchDarkly/Unleash SaaS; media CDN; multipart upload UX.
- Separate worker deployable in v1 (same Nest process hosts workers; forks may split later).

## Decisions

### 1. BullMQ via `@nestjs/bullmq` on the existing Redis, with a dedicated key prefix

Use BullMQ (not Nest `@nestjs/bull` / Bee-Queue) for retries, delayed jobs, and Nest lifecycle hooks.

- **Queues (v1):** `email`, `webhooks.outbound`, `usage.rollups`.
- **Prefix:** e.g. `bull:` + optional `BULLMQ_PREFIX` so keys never collide with usage/throttle keys.
- **Connection:** reuse Redis host/port/password from validated config; separate logical DB index only if Compose already documents it — prefer prefix over a second Redis by default.
- **Workers in-process** for the starter; `QueuesModule` registers processors; shutdown calls `worker.close()` / drains.
- **Rejected:** raw `ioredis` + hand-rolled lists — loses retry/backoff/observability.
- **Rejected:** separate `worker` package in monorepo — premature for a single-process starter.

Email jobs carry provider-neutral payloads (to, subject, body/template id + vars). The processor invokes the existing mail port. Auth flows that must fail visibly on send (registration) MAY still call the port synchronously; non-critical paths (low-balance, admin notifications) enqueue.

Outbound webhook jobs: URL, signed payload body, attempt count; processor POSTs with timeout; failures retry with exponential backoff then land in failed-job visibility (BullMQ failed set + structured log). No generic webhook admin UI in v1.

Usage rollups: periodic/delayed jobs that aggregate Redis counters into optional Postgres snapshots or admin-friendly summaries — **must not** replace synchronous guard consume. Failures of rollups must not affect request admission.

### 2. File storage port: `StorageService` with `local` and `s3` adapters

```ts
interface ObjectStorage {
  put(key: string, body: Buffer | Readable, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer | Readable>;
  delete(key: string): Promise<void>;
  // optional: getSignedUrl(key, expiresInSeconds) on S3; local may return file:// or app-relative path for dev only
}
```

- Config: `STORAGE_DRIVER=local|s3`; local requires `STORAGE_LOCAL_ROOT`; s3 requires bucket + region + credentials group (or IAM role docs for prod forks).
- **Production MUST NOT use `local`** (boot fail) — same pattern as mail development transport.
- Keys are opaque strings owned by callers (`orgs/{id}/…`); no automatic public CDN.
- **Rejected:** Multer-only disk storage as the abstraction — couples HTTP upload to persistence.

### 3. Feature flags: code vocabulary + env defaults + optional DB overrides

- Declare flags in code (`FeatureFlag` const object / enum).
- `FeatureFlagsService.isEnabled(key, context?)` reads: DB override (if present) → env default → code default.
- Context may include `userId`, `organizationId` for future percentage rollouts; v1 may only support global + optional org/user boolean overrides in `FeatureFlagOverride` table.
- Unknown keys: fail at compile time for typed API; runtime string API throws in production / returns false in test only if we expose untyped escape — prefer typed-only.
- **Rejected:** remote SaaS as default.

### 4. Organizations + `BillingSubject` resolver (hooks, not a tenancy suite)

**Schema (sketch):**

- `Organization` (`id`, `slug` unique, `name`, timestamps)
- `OrganizationMember` (`organizationId`, `userId`, `role` enum `owner|admin|member`, unique pair)
- Optional request binding: header `x-organization-id` (or path param) validated against membership

**BillingSubject:**

```ts
type BillingSubject =
  | { type: 'user'; userId: string }
  | { type: 'organization'; organizationId: string };
```

`BillingSubjectResolver.resolve(requestContext)`:

- If org bound and membership ok → `{ type: 'organization', organizationId }` when org-primary billing is enabled for that org (flag or org setting `billingMode: org|user`).
- Else → `{ type: 'user', userId }`.

**Credits:** Extend wallet ownership with a discriminant:

- Prefer **separate nullable FKs** with a check constraint: exactly one of `userId` / `organizationId` set (Prisma + raw SQL check in migration), ledger entries mirror owner.
- Alternative rejected for v1: polymorphic `ownerType`+`ownerId` without FKs — weaker integrity.

`CreditService` methods take `BillingSubject` (or resolve internally from ALS). Gate continues to use principal + optional org context; spends hit org wallet when subject is org.

**Subscriptions:** Add nullable `organizationId` with the same exclusive-owner pattern (user XOR org). Effective plan resolution:

- Org-primary context → entitled org subscription else Lite (or org-default Lite).
- User-primary → existing user subscription rules.

Stripe Checkout remains user-linked in this change (proposal non-goal); org top-up is a follow-up that reuses subject hooks.

Minimal APIs: create org, list my orgs, add/remove member (owner/admin), bind org on subsequent requests. No invitation email product required beyond enqueueing a stub/template if cheap.

### 5. HTTP idempotency middleware for opted-in POSTs

- Decorator `@Idempotent()` (or route metadata) + required header `Idempotency-Key` (UUID/opaque, max length validated).
- Store in Postgres (survives Redis flush): `(key, userId|apiKeyId, method, path, requestHash, statusCode, responseBody, createdAt)` with TTL job or `expiresAt` + periodic cleanup via `usage.rollups`/dedicated cleanup queue.
- First request: process normally; on success (and optionally on 4xx that are deterministic), persist envelope response.
- Replay same key + same hash → return stored status/body without re-running handler.
- Same key + different hash → `409` / `IDEMPOTENCY_KEY_REUSE` (new envelope code).
- In-flight duplicate: second request waits or returns `409`/`425` — prefer **advisory lock / unique constraint + "processing" row** to avoid double side effects.
- Applies to documented starter routes: admin credit adjust, org create, Stripe checkout session create (in addition to ledger-level idempotency keys).

**Rejected:** Redis-only store — loses safety on Redis wipe; Redis may cache but Postgres is source of truth.

### 6. Graceful shutdown order

On `SIGTERM` / Nest shutdown:

1. Mark app not ready (readiness fails) if Terminus supports a shutdown flag.
2. Stop HTTP server accepting new connections (`app.close` path).
3. Pause BullMQ workers; wait for active jobs up to `SHUTDOWN_DRAIN_MS` (config); then force-close.
4. Disconnect Prisma, Redis (shared), storage clients.
5. Exit `0`.

In-flight HTTP still completes within Nest/Express close semantics (existing health-checks requirement, extended).

### 7. Config namespaces

Add validated groups: `queues`, `storage`, `featureFlags`, `idempotency`, `shutdown`, plus org header name if configurable. Extend `.env.example` only — no secrets.

### 8. Low-balance → email queue bridge

Subscribe to existing low-balance domain signal; if flag `email.low_balance` enabled, enqueue `email` job. Keeps credits capability free of direct SMTP while fulfilling the deferred hook from the credits change.

## Risks / Trade-offs

- **[Risk] BullMQ + existing Redis key growth / latency** → Mitigation: dedicated prefix; document memory; optional separate Redis URL later without API change.
- **[Risk] In-process workers block or crash the API process** → Mitigation: bounded concurrency; failed-job isolation; document how forks extract a worker entrypoint.
- **[Risk] Dual wallet model (user XOR org) confuses callers** → Mitigation: single `BillingSubject` type everywhere; gate never guesses; tests for both modes.
- **[Risk] Idempotency store grows unbounded** → Mitigation: `expiresAt` + cleanup job; unique constraint per principal+key.
- **[Risk] Org header spoofing** → Mitigation: membership check always; never trust header alone.
- **[Risk] Sync auth email vs async queue inconsistency** → Mitigation: document which paths are sync; queue failures visible in logs/metrics; no silent drop.
- **[Risk] S3 credentials in env for local forks** → Mitigation: `local` driver default in development; production rejects `local`.

## Migration Plan

1. Ship schema migrations (orgs, members, wallet/subscription owner columns or new org wallet tables, idempotency keys, flag overrides) — expandable, non-destructive to existing user wallets.
2. Deploy config/env additions with safe defaults (queues enabled in Compose; storage `local` in dev; flags default off for new behaviours).
3. Enable workers; verify readiness/shutdown in Compose.
4. Opt-in `@Idempotent()` on critical POSTs; clients may omit header until documented — missing key on decorated routes → `400` `IDEMPOTENCY_KEY_REQUIRED`.
5. Rollback: disable queue processors via flag/env; schema columns remain nullable; user-primary path unchanged.

## Open Questions

- Exact Stripe org top-up timing (explicitly deferred; confirm no partial Checkout-by-org in this change).
- Whether org-primary billing is per-org setting vs global feature flag only (design assumes per-org `billingMode` with flag kill-switch).
- Signed URL support required in v1 for S3 or defer to fork (lean: include simple `getSignedUrl` on S3 adapter only).
