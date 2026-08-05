## 1. Schema and seed

- [x] 1.1 Add Prisma models `Plan`, `PlanEntitlement`, `PlanUsageLimit`, and `Subscription` (enums for interval and status; snake_case `@@map`; `User.subscriptions` relation; uniqueness on plan slug, plan+entitlement, plan+feature)
- [x] 1.2 Generate and commit the migration; confirm no credit-ledger or payment-intent models are introduced
- [x] 1.3 Declare code-level `ENTITLEMENTS` catalogue (string union) used by annotations and seed
- [x] 1.4 Extend the Prisma seed to upsert Lite / Pro / Enterprise plans, full entitlement matrices, and per-plan usage-limit matrices for every `USAGE_FEATURES` entry
- [x] 1.5 Seed tests: empty DB creates catalogues; second run is idempotent; new entitlement key appears on re-seed without duplicates

## 2. Error codes and resolution service

- [x] 2.1 Add `ENTITLEMENT_DENIED` and `SUBSCRIPTION_INACTIVE` to `ErrorCode` without renaming existing codes
- [x] 2.2 Implement `PlanResolutionService`: entitled subscription selection (`active` / `past_due` / `canceled` within `currentPeriodEnd`), Lite slug fallback, entitlements map, and usage ceilings for a user
- [x] 2.3 Unit tests: lifecycle → entitled or not; Pro vs Lite fallback; matrix ceilings preferred over env defaults

## 3. Entitlement gate and module wiring

- [x] 3.1 Implement `@RequireEntitlement` and `@RequirePlan` decorators typed against the entitlement / plan slug catalogues
- [x] 3.2 Implement `EntitlementsGuard` (no-op when undecorated; deny with `ENTITLEMENT_DENIED`; consume AuthGuard principal only)
- [x] 3.3 Register the guard via `APP_GUARD` in a plans/subscriptions module imported after `AuthorizationModule` and before `ThrottlingModule` / `UsageLimitsModule`
- [x] 3.4 Update `AuthorizationModule` comments so slot 3 is entitlements (no longer reserved empty)
- [x] 3.5 Unit tests: allow/deny by entitlement and by minimum plan rank; unannotated pass-through; no session re-resolution

## 4. Usage limits plan awareness

- [x] 4.1 Change `UsageLimitsService` ceiling resolution to use effective-plan matrices when present, else existing config defaults
- [x] 4.2 Unit tests: Pro vs Lite ceilings for the same feature; fallback to env when matrix row missing
- [x] 4.3 Confirm Redis key scheme and fail-closed behaviour are unchanged

## 5. Current-plan API

- [x] 5.1 Add authenticated enveloped `GET` current-plan endpoint returning effective plan, status/interval when present, entitlements, and usage ceilings
- [x] 5.2 E2E: unauthenticated → `401`; authenticated Lite fallback and entitled Pro shapes match resolution rules

## 6. End-to-end and regression

- [x] 6.1 E2E entitlement gate: Lite denied / Pro allowed on a fixture route; denial does not burn usage counters
- [x] 6.2 E2E subscription lifecycle: `past_due` allowed; `canceled` after `currentPeriodEnd` falls back to Lite behaviour
- [x] 6.3 E2E usage limits: same user feature hits different ceilings under Lite vs Pro matrices
- [x] 6.4 Confirm existing auth, throttle, and usage-limit e2e suites still pass

## 7. Documentation

- [x] 7.1 README: document plans (Lite/Pro/Enterprise), intervals, lifecycle, entitlement guard order, seed matrices, Lite fallback; note Stripe/credits as not included
- [x] 7.2 Document new error codes and the current-plan endpoint in the API contract section
