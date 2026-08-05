## Context

The starter’s product surface is largely complete (auth, RBAC, plans, limits, credits, Stripe, orgs, queues, admin, MCP). What remains for “Group 8” is release and contributor quality: OpenAPI currently registers only cookie auth; README Quick start works but is not framed as a five-minute path; there is no Makefile; no Husky/lint-staged/commitlint; CI is a single Node 22 job that already builds the Docker image; e2e files exist for auth, limits, and credits/webhook but are not spelled as mandatory release requirements; `.env.example` already documents Google/Apple/Stripe/Redis but the README does not call those sections out in first-run guidance.

Constraints:

- **Node `>=22.12`** (Better Auth ESM via `require(esm)`). Matrix versions must stay at or above that floor.
- **pnpm scripts are the source of truth**; Make only wraps them.
- **OpenAPI must not invent Nest operations for `/api/auth/*`.** Better Auth stays a mounted surface.
- **`check:env` already syncs `.env.example` ↔ env schema** — prefer documentation over new env files.
- Template readability: forks should delete or keep DX tooling without archaeology.

## Goals / Non-Goals

**Goals:**

- Swagger/OpenAPI exposes Authorize for session cookie, session bearer, and API-key bearer, with operations declaring the schemes they accept.
- A contributor following the README’s lead section reaches a healthy app in about five minutes.
- `make <target>` covers the common loops without replacing `package.json` scripts.
- Pre-commit runs lint-staged; commit messages must be conventional.
- CI verifies on a Node version matrix and builds the production image.
- E2E (or clearly named integration) suites cover auth happy-path, usage-limit ceiling, credits spend/guard, and signed Stripe webhook grant — and CI continues to run them.
- README points at the OAuth / Stripe / Redis sections of `.env.example`.

**Non-Goals:**

- Semantic-release, changelog bots, npm publish, or multi-arch registry push.
- Rewriting Better Auth into OpenAPI paths.
- Separate `.env.*.example` fragments.
- Changing auth, credits, throttle, or Stripe domain rules.
- Replacing pnpm with Make as the only entry point.

## Decisions

### 1. OpenAPI security schemes live in `DocumentBuilder` + selective `@Api*` decorators

Extend the existing Swagger bootstrap in `src/main.ts`:

| Scheme id | Type | Maps to |
| --- | --- | --- |
| `session_token` (existing) | cookie | Better Auth session cookie |
| `session_bearer` | HTTP bearer | Session token in `Authorization: Bearer` (Better Auth) |
| `api_key` | HTTP bearer | Agent API keys (`Authorization: Bearer <key>`) |

Prefer Nest Swagger helpers (`addCookieAuth`, `addBearerAuth`) with distinct names so Swagger UI shows separate Authorize entries. Apply security at controller/operation level where the route actually accepts that scheme (account/session Nest routes → session cookie/bearer; MCP/API-key management as documented; admin → session). Do **not** mark public or webhook routes as requiring session auth.

- **Why not a single “bearer” scheme:** session tokens and API keys are different credentials with different issuers; collapsing them confuses forks and agents.
- **Why not document `/api/auth/*` as Nest operations:** the library owns that surface; the OpenAPI description already states the boundary — keep that, enrich schemes for Nest only.
- **Rejected:** exporting a static `openapi.json` checked into git — generated-from-code stays the source of truth; optional future `pnpm openapi:export` is fine but not required.

Admin vs public **tags** remain owned by `admin-api`; this change’s `openapi-contract` owns **security schemes**.

### 2. README lead is a timed “5-minute first run”; depth stays below

Restructure the top of `README.md`:

1. One-line product pitch (keep).
2. **5-minute first run** — numbered steps with expected elapsed time, ending in `curl /health/ready` (and note that `db:seed` is required before authz-heavy flows).
3. Link out: “Configure Google / Apple / Stripe” → anchors into Configuration / `.env.example` sections.
4. Existing “What’s in the box”, Scripts, deeper Docker notes move below or stay after the timed path.

Do not invent a second Compose path. Use the existing `pnpm docker:up` + migrate + seed (or Make equivalents). Call out that Compose supplies production-safe secret/mail overrides so the placeholder `.env` still boots in containers.

### 3. Makefile wraps pnpm; phony targets only

Root `Makefile` with `.PHONY` targets such as:

| Target | Invokes |
| --- | --- |
| `up` / `down` / `logs` | `pnpm docker:*` |
| `migrate` / `seed` | `pnpm db:migrate:deploy` / `db:seed` |
| `test` / `test-e2e` / `test-smoke` | corresponding pnpm scripts |
| `lint` / `typecheck` / `build` | corresponding pnpm scripts |
| `image` | `docker build --target runner …` |
| `ci-local` | lint → typecheck → test → migrate → e2e → build → smoke (best-effort local mirror) |

No logic in Make beyond calling scripts. Document `make help` (or a default target that lists targets).

### 4. Husky + lint-staged + commitlint (conventional)

- `husky` via `prepare` script so `pnpm install` installs hooks.
- **pre-commit:** `lint-staged` running ESLint `--fix` (and Prettier if already wired) on staged `*.ts` under `src/`, `test/`, `scripts/`.
- **commit-msg:** `@commitlint/cli` + `@commitlint/config-conventional`.
- Document `HUSKY=0` / `--no-verify` as escape hatches for emergencies (not for normal contribution).
- Do **not** block pushes with full e2e (too slow); CI remains the heavy gate.

- **Rejected:** Lefthook / simple-git-hooks — Husky is the Nest/JS ecosystem default and matches contributor expectations.
- **Rejected:** enforcing conventional commits only in CI — local feedback is the point of Group 8.

### 5. CI: Node matrix + keep image build

```yaml
strategy:
  fail-fast: false
  matrix:
    node-version: [22, 24]   # 22 = engines floor / LTS; 24 = current
```

Services (Postgres, Redis), frozen lockfile, and step order stay as today. Docker image build can run once (e.g. only on `node-version == 22`) to avoid doubling build time, or on every matrix cell if cheap enough — prefer **once on the primary version** with an explicit job name.

No GHCR push in this change.

### 6. E2E release coverage = name and keep suites; fill gaps only

Treat these as required suites (already largely present):

| Area | Existing / action |
| --- | --- |
| Auth | `test/auth-surface.e2e-spec.ts` — ensure sign-up → verify → sign-in remains; add only if a happy-path hole exists |
| Usage limits | `test/usage-limits.e2e-spec.ts` — ceiling → enveloped 429 |
| Credits | `test/credits-stripe.e2e-spec.ts` — spend/guard + Stripe checkout/webhook |
| Billing webhook | same file — signed grant + reject bad signature |

Spec/requirement language makes these **mandatory**; implementation work is gap-fill and README/CI documentation, not a new test framework.

### 7. Sample env: one file, better discoverability

Keep `.env.example` as the only sample. Tighten section comments for Google/Apple/Stripe/Redis if needed. README Configuration section gets explicit deep links / headings so “Sample .env for Google/Apple/Stripe/Redis” is satisfied without duplicating files.

## Risks / Trade-offs

- **[Husky ignored in some environments]** → Document `pnpm exec husky` / `prepare`; CI still enforces lint and (optionally later) commitlint on PR titles — out of scope unless trivial; local hooks are best-effort for GUI clients.
- **[Node 24 breaks a dependency]** → `fail-fast: false` surfaces it; pin matrix or mark 24 `continue-on-error` only if a known upstream issue blocks — prefer fail loud and fix.
- **[lint-staged slows commits]** → Scope to staged files only; do not run full Jest on pre-commit.
- **[OpenAPI security noise on public routes]** → Apply schemes per-controller; never global `addSecurity` that marks every route authenticated.
- **[Make drift from package.json]** → Make only shells out to named scripts; README lists both.

## Migration Plan

1. Land OpenAPI scheme + decorator updates (no runtime behavior change).
2. Add Makefile + README 5-minute section (docs-only for forks mid-flight).
3. Add husky/lint-staged/commitlint as devDependencies; run `pnpm install` once to create hooks.
4. Expand CI matrix; keep image build on primary Node.
5. Audit e2e suites; add only missing scenarios; confirm CI still green.

Rollback: revert the change; remove hooks with `rm -rf .husky` and drop the `prepare` script if needed. No data migration.

## Open Questions

- Whether commitlint should also run in CI on PR titles (nice-to-have; default **no** in this change to keep scope tight).
- Exact Node 24 inclusion if CI flakes on first try — fall back to `22` + `22.12` only if 24 is untenable (prefer keeping 24).
