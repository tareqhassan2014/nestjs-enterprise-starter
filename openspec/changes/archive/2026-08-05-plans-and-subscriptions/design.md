## Context

Auth → RBAC → *(empty entitlements slot)* → Nest throttle → usage limits → *(empty credits)* is the documented chain. Usage ceilings come only from env (`USAGE_LIMIT_*`); `data-persistence` still forbids plan/subscription models. Stripe and credits are next and need a plan catalogue, interval vocabulary, and subscription lifecycle to attach to — inventing those ad hoc inside a Stripe change would couple payment plumbing to product packaging.

Constraints: reuse Prisma + existing envelope; consume the AuthGuard principal (no second session lookup); keep RBAC orthogonal to commercial entitlements; prefer seeded DB matrices over a large new env surface; no Stripe in this change.

## Goals / Non-Goals

**Goals:**

- Persist Lite / Pro / optional Enterprise plans with monthly and yearly interval support on subscriptions.
- Code-declared entitlement keys with per-plan boolean values; Nest gate after RBAC for annotated routes.
- Per-plan daily/weekly usage-limit matrices that feed `UsageLimitsService` when a subscription is entitled.
- Subscription lifecycle (`active`, `past_due`, `canceled`) with clear rules for what is entitled.
- Idempotent seed for plans + matrices; default Lite behaviour so new users are not soft-locked.
- Distinct envelope error codes for plan denials (not `FORBIDDEN`, not `USAGE_LIMIT_EXCEEDED`).

**Non-Goals:**

- Stripe, Checkout, Customer Portal, webhooks, price IDs as load-bearing behaviour (nullable Stripe price id columns are allowed as forward-compat, unused).
- Credit ledger, org/team billing, admin plan CRUD UI, full public catalogue management API.

## Decisions

### 1. Four Prisma models — Plan, PlanEntitlement, PlanUsageLimit, Subscription

**Choice:**

| Model | Role |
|-------|------|
| `Plan` | Stable slug (`lite`, `pro`, `enterprise`), display name, `rank` (ordering / minimum-plan checks), `isActive`, optional marketing metadata |
| `PlanEntitlement` | `(planId, entitlementKey)` → `enabled` boolean; unique on pair |
| `PlanUsageLimit` | `(planId, feature)` → `dailyLimit`, `weeklyLimit`; unique on pair; `feature` matches `USAGE_FEATURES` catalogue strings |
| `Subscription` | `userId`, `planId`, `interval` (`monthly` \| `yearly`), `status`, period bounds, optional `canceledAt` / Stripe ids for later |

Table names snake_case via `@@map`. `User` gains `subscriptions Subscription[]`.

**Why not** embed entitlements as JSON on `Plan`: cannot constrain keys or uniqueness; harder to seed/diff. **Why not** one row per price (Lite-monthly as its own plan): interval belongs on the subscription; the commercial *tier* is the plan. Stripe Price objects map later via optional columns, not by exploding the plan catalogue.

### 2. Entitlement vocabulary in code; values in the database

**Choice:** Mirror permissions — `ENTITLEMENTS` const object (string union) is the only vocabulary annotations may use. Seed upserts `PlanEntitlement` rows for every `(plan, key)`. Unknown keys in annotations fail at compile time; orphan DB rows have no effect.

Starter keys (illustrative; exact set fixed at apply):

- `feature.advanced` — Pro+ gated demo capability
- `feature.priority_support` — Enterprise (or Pro) flag for template completeness
- Keep the set small; forks extend the const + seed.

**Why not** free-form strings in decorators: same silent-miss problem permissions already solved.

### 3. Subscription status and entitlement eligibility

**Choice:** Status enum: `active` | `past_due` | `canceled`.

| Status | Entitled for gates + plan matrices? |
|--------|-------------------------------------|
| `active` | Yes |
| `past_due` | Yes (grace — payment retry window; Stripe will drive this later) |
| `canceled` | Yes **only while** `currentPeriodEnd` is set and `now < currentPeriodEnd`; otherwise No |

At most one **entitled** subscription per user at a time enforced in application logic when creating/updating (unique partial index optional: prefer app-level + tests in the starter; document that Stripe webhooks must not create a second concurrent entitled row without canceling the prior).

**Why not** `trialing` / `incomplete` yet: Stripe introduces them; adding unused enum values is fine later via migration. **Why not** entitle `canceled` forever: soft-locks downgrades.

### 4. Default / missing subscription → effective Lite

**Choice:** Resolution order:

1. Load the user’s entitled subscription (per decision 3); use its plan.
2. Else treat effective plan as the seeded `lite` plan (by slug).

New signups do **not** require a DB subscription row to use Lite ceilings and Lite entitlements. Optionally (apply-time nicety): a Better Auth `user.create` hook or post-signup service inserts an explicit `active` / `monthly` Lite subscription for clearer Stripe handoff — **recommended but not required** for entitlement correctness.

**Why not** “no plan = no access to anything”: breaks the starter’s out-of-box DX and health of demo metered routes. **Why not** env-only Lite without a Plan row: matrices and seed would diverge.

### 5. EntitlementsGuard fills slot 3; import order is the contract

**Choice:** `PlansModule` (or `SubscriptionsModule` exporting the guard) registers `APP_GUARD` → `EntitlementsGuard`. In `AppModule`, import it **after** `AuthorizationModule` and **before** `ThrottlingModule` / `UsageLimitsModule`. Update the comment block in `AuthorizationModule` so slot 3 is no longer “reserved”.

Decorators:

- `@RequireEntitlement(key)` — all listed keys must be enabled on the effective plan.
- Optional `@RequirePlan('pro')` — effective plan `rank` ≥ named plan’s rank (Lite < Pro < Enterprise).

Routes without these annotations: guard no-ops (same pattern as `@UsageLimit`).

Guard reads principal from the request / request context; loads effective entitlements via `PlanResolutionService` (request-scoped memoization). Does **not** call Better Auth again.

Denial codes:

| Case | HTTP | `error.code` |
|------|------|----------------|
| Entitlement flag false / plan rank too low | 403 | `ENTITLEMENT_DENIED` |
| (Reserved) explicit “subscription required and inactive” if we later distinguish | 403 | `SUBSCRIPTION_INACTIVE` |

For this change: missing entitlement and ineligible canceled subscription both surface as `ENTITLEMENT_DENIED` when a decorator is present (client remedy: upgrade / renew). Use `SUBSCRIPTION_INACTIVE` only if a route requires *any* entitled subscription without a specific flag — include the code in the enum for that case; prefer one decorator path in the starter.

Response bodies MUST NOT list the caller’s full entitlement map (same posture as RBAC).

### 6. Usage ceilings: plan matrix first, then env defaults

**Choice:** Change `UsageLimitsService` ceiling resolution to:

1. If `subject.userId` has an effective plan with a `PlanUsageLimit` row for the feature → use those daily/weekly values.
2. Else → existing env / config map (`USAGE_LIMIT_<FEATURE>_` / default).

Ceiling lookup may be async (DB or short-lived cache). Cache plan matrices in memory at module init **or** Redis with TTL; invalidation on seed re-run is rare — **in-process cache of plan matrices keyed by planId**, refreshed on process boot, is enough for the starter. Per-user plan identity still needs a DB (or Redis) read unless memoized on the request.

**Why not** delete env ceilings: needed for users before seed, tests, and fallback. **Why not** put ceilings only in env keyed by plan: loses DB as source of truth for commercial packaging.

### 7. Seed matrices (starter defaults)

**Choice:** Idempotent upserts:

| Plan | Rank | Notable entitlements | `demo` daily/weekly (example) |
|------|------|----------------------|-------------------------------|
| Lite | 10 | advanced=false | lower (e.g. 100 / 500 — align with current env demo defaults) |
| Pro | 20 | advanced=true | higher |
| Enterprise | 30 | advanced=true, priority_support=true | highest or unlimited sentinel |

**Unlimited:** represent as a very large positive int in the matrix (document), not null — keeps Redis compare logic simple. Null meaning unlimited is a footgun for `remaining` maths.

Enterprise is seeded and `isActive=true` but not required in product copy; forks may set `isActive=false` to hide it from a future catalogue endpoint.

### 8. Minimal read API

**Choice:** Authenticated `GET /api/v1/billing/plan` (or `/me/plan`) returning enveloped `{ plan, interval, status, entitlements, limits }` for the effective plan. No public unauthenticated catalogue required in this change (optional thin `GET /plans` public list of active plans without limits internals — nice-to-have; skip unless tasks need it for demos).

No PATCH/POST subscription mutation APIs yet (Stripe will own those).

### 9. Error envelope additions only

**Choice:** Add `ENTITLEMENT_DENIED` and `SUBSCRIPTION_INACTIVE` to `ErrorCode`. Do not overload `FORBIDDEN`. Document in `api-response-envelope` that plan denials are distinct so clients can show upgrade UI vs contact-admin UI.

## Risks / Trade-offs

**Implicit Lite without a subscription row** → Mitigated by documenting resolution rules; Stripe apply should insert explicit rows on checkout so interval/status become real.

**past_due still entitled** → Abuse if status stuck; acceptable until Stripe webhooks; operators can cancel manually.

**In-process plan matrix cache stale after live DB edit** → Starter expects seed/redeploy; document; optional TTL or admin bust later.

**Guard import order mistakes** → Mitigated by AppModule order + e2e that entitlement denial happens without incrementing usage (same pattern as RBAC-before-throttle tests).

**RBAC vs entitlement confusion** → Docs: permissions = what staff/actions; entitlements = what the commercial plan unlocks. A route may require both.

**Partial unique “one active subscription”** → App-enforced initially; risk of duplicates under concurrent webhooks later → add partial unique index when Stripe lands if Postgres version supports it.

## Migration Plan

1. Prisma migration: plans, plan_entitlements, plan_usage_limits, subscriptions; User relation.
2. Seed plans + matrices; extend seed tests for idempotency.
3. `PlanResolutionService` + ErrorCodes + EntitlementsGuard + AppModule import order.
4. Wire usage ceiling resolution to matrices; unit tests with Lite vs Pro ceilings.
5. E2E: gated route allow/deny; canceled after period end denied; usage limits differ by plan; seed twice.
6. README: plans, intervals, lifecycle, guard order, non-goals (no Stripe yet).
7. Rollback: revert deploy + migration down; Redis usage keys unaffected structurally.

## Open Questions

1. **Exact starter entitlement key names and numeric limit matrix** — pick concrete values at apply; not blocking design.
2. **Whether signup always inserts a Lite subscription row** — recommended; implement if Better Auth hook is low-friction, else rely on implicit Lite.
3. **Public plan catalogue endpoint** — defer unless a demo UI needs it in the same change.
