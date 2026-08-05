## Why

Auth, plans, throttling, credits, Stripe, admin, and MCP are in place, but side effects still run on the request thread, there is no shared file or feature-flag substrate, HTTP POSTs that matter can double-apply on client retry, and billing remains strictly user-scoped despite usage-limit keys already reserving an organization dimension. Forks that need background work, object storage, org wallets, or safe retries will invent incompatible queues, storage clients, and wallet shapes unless the starter ships one opinionated cross-cutting layer now.

## What Changes

- **BullMQ job queues**: Redis-backed queues and workers for transactional email dispatch, outbound webhook delivery, and usage counter rollups/aggregations, with retries, dead-letter visibility, and Nest lifecycle integration.
- **Mailer queue integration**: Keep the existing provider-agnostic mail port; add a queue-backed dispatch path so non-blocking sends go through BullMQ while auth-critical paths retain fail-visible semantics as designed.
- **File storage abstraction**: Injectable storage port with local filesystem and S3-compatible adapters selected by config; application code never imports the S3 SDK or `fs` paths directly.
- **Graceful shutdown hardening**: On `SIGTERM`, stop accepting work, drain in-flight HTTP and queue jobs (within a timeout), then close Prisma, Redis, BullMQ, and storage clients before exit `0`.
- **Feature flags service**: Code-declared flag keys with runtime evaluation (env/bootstrap defaults + optional persisted overrides) so forks can gate incomplete surfaces without redeploying for every toggle.
- **Multi-tenant / org wallet hooks**: Minimal Organization + membership model and a billing-subject resolver so credits and effective plan can be org-primary when a request/context carries an org, without rewriting the entire product into a full SaaS tenancy suite.
- **HTTP idempotency middleware**: `Idempotency-Key` (or equivalent) support for opted-in critical POSTs — store request fingerprint + response for a TTL so retries return the original outcome instead of double-charging, double-enqueuing, or double-mutating.

### Non-goals

- **No full multi-tenant product suite.** No org invitations UI, SSO-per-tenant, custom domains, or per-org branding. Org + membership + billing-subject hooks only.
- **No migrating all existing user wallets/subscriptions to org-owned in one cut.** User-scoped credits and subscriptions remain valid; org-primary is opt-in via resolver hooks and new paths.
- **No replacing Stripe webhooks with a generic webhook product.** Outbound webhook *delivery* jobs are in scope; inbound Stripe (and Better Auth) handling stays as today.
- **No third-party feature-flag SaaS (LaunchDarkly, etc.).** Local/config/DB evaluation only; adapter hook for later is fine but not required.
- **No CDN, image transforms, or multipart upload UX.** Storage port covers put/get/delete (and signed URL if trivial); not a media platform.
- **No rewriting transactional-email provider adapters.** SMTP + development record adapters stay; queue sits behind or beside the port.
- **No changing auth → RBAC → entitlements → throttle → usage → credits order.** Idempotency and flags wrap or annotate; they do not reorder commercial gates.
- **No Kubernetes-specific shutdown controllers** beyond Nest `enableShutdownHooks` + documented `SIGTERM` behaviour usable in Compose/K8s.

## Capabilities

### New Capabilities

- `job-queues`: BullMQ queues/workers on the existing Redis connection for email, outbound webhooks, and usage rollups; retry/backoff; Nest module lifecycle; metrics/logging hooks without high-cardinality labels.
- `file-storage`: Provider-agnostic object storage port with `local` and `s3` adapters, validated config groups, and boot failure if production selects an unsafe/incomplete transport.
- `feature-flags`: Declared flag vocabulary, evaluation API (boolean and optional string/number variants as designed), env/default + optional persistence overrides, fail-closed unknown keys in production as designed.
- `request-idempotency`: Opt-in HTTP idempotency for critical POSTs via client key + method/path/body fingerprint, TTL-backed stored responses, conflict on key reuse with different payload.
- `organizations`: Minimal Organization entity, membership (role within org as designed), request/context org binding, and billing-subject hooks so credits and plan resolution can prefer the org wallet/subscription when present.

### Modified Capabilities

- `transactional-email`: Allow (or prefer) enqueueing delivery through `job-queues` while preserving the provider-agnostic port, development recording for tests, and no silent success on dispatch failure.
- `health-checks`: Extend graceful shutdown requirements to drain queue workers and close storage/queue clients; readiness MAY reflect worker/Redis queue dependency as designed without turning liveness into a dependency probe.
- `credits`: Add org-scoped wallet resolution hooks — when billing subject is an organization, spend/grant/balance operate on the org wallet; user wallets remain for user-primary contexts.
- `subscriptions`: Support org-primary subscription binding and effective-plan resolution when the billing subject is an organization (user fallback/Lite rules preserved for user-primary contexts).
- `data-persistence`: Schema + migrations for organizations/membership, idempotency records, optional feature-flag overrides, org credit wallets (or wallet owner discriminant), and any queue-related persistence that must survive restarts (prefer Redis for BullMQ state).
- `app-configuration`: Validated env for BullMQ/prefix, mail queue toggles, storage (`local`/`s3` + credentials/bucket), feature-flag defaults, idempotency TTL, graceful-shutdown timeouts; `.env.example` updates.
- `api-response-envelope`: Stable error codes for idempotency conflicts (and any org-context / flag evaluation client-facing failures that belong in the envelope).
- `usage-limits`: Wire optional async rollup/aggregation jobs via `job-queues` without changing the synchronous consume/reject semantics of the guard.

## Impact

**Code**
- New modules: queues (producers/processors), storage, feature-flags, idempotency middleware/interceptor, organizations (models, membership, billing-subject resolver).
- Modified: mail module (enqueue path), bootstrap/shutdown, credits + subscription resolution, Prisma schema/migrations, config schema, envelope error codes, README.
- Dependencies: `bullmq`, `@nestjs/bullmq` (or equivalent Nest integration), AWS SDK v3 S3 client (or `@aws-sdk/client-s3`) for the S3 adapter.

**APIs**
- Minimal org create/list/membership reads under `/api/v1` as needed for hooks to be exercisable (keep surface small).
- No public “admin feature flag console” required beyond what tests and a thin authenticated/admin read need; flags primarily code/config driven.
- Critical POSTs (document the starter set: e.g. credit top-up session create, admin credit adjust, org-sensitive mutations) accept `Idempotency-Key` and return stored responses on replay.

**Auth / billing / credits / throttle**
- Auth and RBAC unchanged in order; org membership checks apply where org-scoped routes exist.
- Credits and plans gain an org-primary path via billing-subject hooks; user-primary behaviour remains default when no org context is bound.
- Throttle/usage keep existing keys; usage rollups are async maintenance, not a second enforcement path.
- Stripe top-up and webhooks remain user-linked unless a follow-up explicitly adds org Checkout — this change only prepares wallet/plan subject hooks.
