## Why

Feature work (auth, plans, limits, credits, orgs, queues) is largely in place, but contributor and release DX still lag: OpenAPI documents only cookie auth, the README first-run path is longer than a true five-minute onboarding, there is no Makefile of scripted workflows, git hooks / conventional commits are absent, CI is a single Node job without a version matrix, and e2e coverage for auth / limits / credits / billing webhooks is unevenly spelled as a release gate. Closing this gap makes forks ship-ready and keeps the open-source template trustworthy.

## What Changes

- **OpenAPI / Swagger auth schemes**: Document every supported Nest auth mechanism in the generated OpenAPI document (session cookie, session bearer, API-key bearer) and map them to the routes that accept them; keep Admin vs public tagging; keep Better Auth / health / metrics / Stripe webhook outside the enveloped Nest contract.
- **README 5-minute first run**: Lead with a timed, copy-pasteable path from empty clone → healthy `/health/ready` (and optional seed) in about five minutes; push deeper topics (hot reload, host ports, outside-Docker) below the fold.
- **Makefile / scripted workflows**: Add a root `Makefile` (wrapping existing `pnpm` / Compose scripts) for the common contributor loops: stack up/down, migrate/seed, unit/e2e/smoke, lint/typecheck, Docker image build.
- **E2E release coverage**: Treat e2e suites for authentication (sign-up → verify → sign-in), usage limits (429 on ceiling), credits spend/guard, and Stripe billing webhook grant as required release gates — fill gaps where scenarios are missing or only unit-covered.
- **Husky + lint-staged + conventional commits**: Install and wire pre-commit (lint-staged on staged TS) and commit-msg (conventional commits) hooks; document how to bypass only when intentionally needed.
- **GitHub Actions matrix + Docker image**: Run the verify job on a Node version matrix (at least the engines floor and current LTS/current); keep Docker production image build as a CI gate (already present — keep and document; optional tag-triggered publish remains out of scope unless trivial).
- **Sample `.env`**: Keep `.env.example` as the single annotated sample covering Google, Apple, Stripe, Redis (and the rest of the schema); ensure README points to the OAuth/Stripe/Redis sections explicitly in the first-run / config docs.

### Non-goals

- **No rewriting Better Auth into Nest OpenAPI operations.** Document the boundary and auth schemes for Nest routes only.
- **No hosted docs portal, Redoc enterprise, or separate OpenAPI versioning product.** Swagger UI at `/docs` + generated document is enough.
- **No semantic-release / automated npm publish / changelog bot.** Conventional commits enable that later; this change only enforces message shape and local hooks.
- **No multi-arch Docker bake matrix or registry publish pipeline** beyond building the production image in CI (forks own GHCR/ECR push).
- **No rewriting auth, credits, throttle, or Stripe domain semantics** — only documentation, DX scripts, CI shape, and e2e coverage of existing behavior.
- **No replacing `pnpm` scripts with Make-only workflows.** Make is a thin wrapper; scripts remain the source of truth.
- **No separate `.env.oauth.example` / `.env.stripe.example` files.** One `.env.example` stays canonical (CI `check:env` already enforces schema sync).

## Capabilities

### New Capabilities

- `openapi-contract`: Generated OpenAPI/Swagger contract that documents Nest security schemes (session cookie, session bearer, API-key bearer), applies them to the correct route groups, and preserves Admin vs public tagging plus non-envelope boundary notes.
- `commit-quality`: Local git quality gates — Husky-managed hooks, lint-staged on staged sources, and conventional commit message validation on `commit-msg`.
- `scripted-workflows`: Root Makefile (and documented aliases) wrapping the existing pnpm/Compose workflows for stack, database, test, and image tasks.

### Modified Capabilities

- `developer-environment`: Require a documented ≤5-minute first-run path; CI Node version matrix; production Docker image build retained as a gate; e2e coverage for auth, usage limits, credits, and Stripe billing webhook as mandatory suites; README must point contributors at the Google/Apple/Stripe/Redis sections of `.env.example`.
- `admin-api`: Narrow OpenAPI tagging requirement remains; defer detailed security-scheme documentation to `openapi-contract` (delta clarifies the split so Admin tagging does not own auth-scheme completeness).

## Impact

**Code / repo**
- OpenAPI bootstrap in `src/main.ts` (and controller `@Api*Auth` / security decorators where needed).
- New: `Makefile`; Husky config (`.husky/`), lint-staged + commitlint (or equivalent) config; package.json `prepare` / hook scripts.
- Modified: `README.md` (5-minute lead); `.github/workflows/ci.yml` (Node matrix); possibly new or expanded e2e specs under `test/`; `.env.example` comments only if a section is unclear (no schema churn unless a documented variable is missing — prefer docs).

**Dependencies**
- Dev: `husky`, `lint-staged`, `@commitlint/cli` + conventional config (or project-chosen equivalent).

**APIs**
- No new business endpoints. OpenAPI document gains security schemes and richer operation security metadata; Swagger UI behavior unchanged aside from Authorize options.

**Auth / billing / credits / throttle**
- Unchanged runtime gates. E2E must prove: auth flow works; usage limit returns the expected enveloped 429; credits guard/spend path works; Stripe webhook credits the wallet with signature verification. No change to plan/throttle/credit product rules.
