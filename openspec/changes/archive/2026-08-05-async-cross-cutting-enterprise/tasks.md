## 1. Dependencies and configuration

- [x] 1.1 Add BullMQ / `@nestjs/bullmq` and S3 client dependencies; wire package scripts if needed
- [x] 1.2 Extend Zod env schema + config namespaces for queues, storage, feature flags, idempotency TTL/key bounds, and shutdown drain timeout
- [x] 1.3 Update `.env.example` and README with the new variables and safe defaults (local storage in dev; production rejects local)

## 2. Schema and persistence

- [x] 2.1 Add Prisma models for Organization, OrganizationMember, FeatureFlagOverride, and IdempotencyRecord (with expiry + uniqueness)
- [x] 2.2 Extend CreditWallet / CreditLedgerEntry and Subscription for exclusive user XOR organization ownership (migration + check constraint)
- [x] 2.3 Generate client, apply migration in Compose, and add minimal seed hooks if required for tests

## 3. Job queues

- [x] 3.1 Create QueuesModule with BullMQ connection, key prefix, and queues `email`, `webhooks.outbound`, `usage.rollups`
- [x] 3.2 Implement email processor that calls the existing mail port; add enqueue helper for non-critical sends
- [x] 3.3 Implement outbound webhook processor with timeout, retries/backoff, and structured failure logging
- [x] 3.4 Implement usage rollup processor skeleton that reads Redis counters without affecting live consume
- [x] 3.5 Unit/integration tests for enqueue + retry/failure visibility (mocked mail/HTTP where appropriate)

## 4. Mailer queue integration

- [x] 4.1 Add queue-backed send path beside sync mail port usage; keep auth verification/reset on fail-visible sync path
- [x] 4.2 Bridge low-balance domain signal to `email` queue behind a feature flag / config toggle
- [x] 4.3 Tests: enqueue on low-balance when enabled; sync auth mail still goes through port

## 5. File storage

- [x] 5.1 Define ObjectStorage port and LocalStorageAdapter writing under configured root
- [x] 5.2 Implement S3StorageAdapter; boot-fail when production selects local or S3 group is incomplete
- [x] 5.3 Nest StorageModule selecting adapter from config; unit tests for put/get/delete on local adapter

## 6. Feature flags

- [x] 6.1 Declare flag vocabulary in code and implement FeatureFlagsService (override → env → code default)
- [x] 6.2 Optional org/user override persistence + evaluation context
- [x] 6.3 Unit tests for resolution order and typed unknown-key rejection

## 7. Organizations and billing subject

- [x] 7.1 OrganizationsModule: create org, list mine, membership add/remove with role checks
- [x] 7.2 Request org binding (header or equivalent) with membership validation into request context / ALS
- [x] 7.3 BillingSubjectResolver (user vs organization based on binding + org billing mode)
- [x] 7.4 E2E/API tests for membership enforcement and subject resolution

## 8. Credits and subscriptions org-primary hooks

- [x] 8.1 Refactor CreditService to accept BillingSubject; support org wallet grant/spend/balance
- [x] 8.2 Update credits gate and balance read to use billing subject; keep user-primary default
- [x] 8.3 Extend subscription persistence + effective-plan resolution for org-owned subscriptions
- [x] 8.4 Tests for org spend/ledger idempotency and org-primary plan resolution (Lite fallback)

## 9. Request idempotency

- [x] 9.1 Implement IdempotencyInterceptor/middleware with request hash, processing lock, stored response, expiry
- [x] 9.2 Add `@Idempotent()` metadata and apply to critical POSTs (org create, admin credit adjust, checkout session create)
- [x] 9.3 Add envelope codes `IDEMPOTENCY_KEY_REQUIRED` and `IDEMPOTENCY_KEY_REUSE`
- [x] 9.4 Tests: missing key, replay, conflicting reuse, concurrent duplicate safety

## 10. Graceful shutdown and usage rollup wiring

- [x] 10.1 Extend shutdown hooks: readiness not-ready flag, drain BullMQ workers within timeout, close storage/queue clients
- [x] 10.2 Schedule or trigger usage rollup enqueue path (cron/interval or admin-triggered) without changing guard semantics
- [x] 10.3 Smoke test SIGTERM drain behaviour in Compose or documented script

## 11. Docs and verification

- [x] 11.1 Document org binding header, idempotency header, queue names, and storage drivers in README
- [x] 11.2 Run unit + e2e suites covering credits ledger, org hooks, and idempotent POSTs; fix regressions
