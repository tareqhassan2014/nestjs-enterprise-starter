## Why

Auth, RBAC, throttling, and usage counters are in place, but every metered or premium feature still has nowhere to ask “is this caller on a plan that allows this?” Usage ceilings today come only from env defaults; the reserved entitlements guard slot is empty. Without a plan catalogue, subscription lifecycle, and a gate that runs after RBAC and before expensive work, forks will invent ad-hoc plan checks and Stripe will have nothing coherent to attach to.

## What Changes

- **Plan catalogue**: Lite and Pro as first-class plans, plus an optional Enterprise plan (present in the model and seedable; not required for every fork to expose commercially).
- **Billing intervals**: monthly and yearly as first-class subscription intervals (pricing fields optional/placeholder until Stripe; interval itself is persisted and queryable now).
- **Entitlements**: boolean feature flags per plan (code-declared entitlement keys, values seeded per plan) so routes and services can require a capability without hard-coding plan names.
- **Usage limit matrices**: per-plan daily/weekly ceilings for catalogue usage features, seeded alongside plans so `UsageLimitsService` can resolve ceilings from the caller’s effective plan instead of only env defaults.
- **Subscription lifecycle**: a user may hold a subscription in `active`, `past_due`, or `canceled` (and related transitional states as designed); effective entitlements and limit matrices derive from the subscription that is currently in force.
- **Plan / entitlement gate**: Nest guard filling the reserved slot after authorization and before throttling/usage — annotated routes requiring an entitlement (or minimum plan) fail closed with a distinct envelope code before handlers run.
- **Idempotent seed**: default Lite/Pro(/Enterprise) rows, entitlement matrices, and usage-limit matrices; safe to re-run.

### Non-goals

- **No Stripe, Checkout, webhooks, or invoice sync.** Subscription rows and intervals exist so billing can attach later; payment collection is a later change.
- **No credit ledger or pay-as-you-go top-up.** Credits remain after usage checks in the guard chain and stay out of scope.
- **No organizations / team billing.** Subscriptions are user-scoped; org dimension on usage keys stays unused.
- **No admin UI and no full plan CRUD API.** Seed + domain services + a minimal read surface (current plan / entitlements) for the authenticated caller; operator plan edits via DB/seed for the starter.
- **No migration of existing users to paid plans in production.** New installs seed plans; assigning a default Lite subscription (or none) is a design decision, not a live-traffic upgrade path.
- **No rewriting of RBAC.** Roles/permissions stay orthogonal to plan entitlements (who may administer vs what the product plan allows).

## Capabilities

### New Capabilities

- `plans`: Plan catalogue (Lite / Pro / optional Enterprise), monthly/yearly interval vocabulary, code-declared entitlement keys with per-plan boolean values, per-plan usage-limit matrices for catalogue features, and the Nest entitlement/plan gate that occupies the reserved guard-chain slot.
- `subscriptions`: User↔plan subscription records, billing interval, lifecycle states (`active`, `past_due`, `canceled`, plus any transitional states fixed in design), resolution of the caller’s effective plan/entitlements/limits, and rules for what happens when no subscription exists or the subscription is not in an entitled state.

### Modified Capabilities

- `data-persistence`: Supersede the baseline-schema rule that forbids plan/subscription/entitlement models; extend the idempotent seed to create default plans, entitlement matrices, and usage-limit matrices (uniqueness constraints, not script bookkeeping).
- `authorization`: Guard-chain documentation updates so plan entitlements are no longer a reserved empty slot — the entitlements guard is registered and ordered after RBAC and before throttling/usage/credits.
- `usage-limits`: Effective daily/weekly ceilings for a subject MUST prefer the active plan’s matrix when a subscription is in force, falling back to configured env defaults when no entitled plan applies (exact fallback rules in design/spec).
- `api-response-envelope`: Error-code set gains stable identifiers for plan/entitlement denials and inactive-subscription outcomes (distinct from `FORBIDDEN` RBAC denials and from `USAGE_LIMIT_EXCEEDED`).

## Impact

**Code**
- New: Prisma models/migrations for plans, plan entitlements, plan usage limits, subscriptions; plans/subscriptions modules; entitlement guard + decorators; seed data; resolution service used by the gate and by usage-limit ceiling lookup.
- Modified: `AuthorizationModule` / `AppModule` guard registration comments and import order; `UsageLimitsService` ceiling resolution; `ErrorCode` + filter mapping; `.env.example` only if new config is required (prefer DB-seeded matrices over new env sprawl); README.
- Tests: unit tests for lifecycle → effective entitlements/limits; e2e for gated route deny/allow by plan; seed idempotency; usage ceilings differing by plan.

**APIs**
- Entitlement-annotated Nest routes return a distinct `403` (or documented code) when the plan lacks the feature or the subscription is not entitled — handler does not run.
- Optional minimal authenticated read of “my plan / entitlements” under `/api/v1` (enveloped). No public Stripe portal in this change.

**Auth / billing / credits / throttle**
- Auth and RBAC unchanged in behaviour; entitlements consume the already-resolved principal.
- Throttling and usage still run after entitlements so denied plan checks do not burn quotas.
- Stripe/credits remain downstream; this change owns the commercial plan model they will bind to.
