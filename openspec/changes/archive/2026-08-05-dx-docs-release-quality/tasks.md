## 1. OpenAPI security schemes

- [x] 1.1 Extend `DocumentBuilder` in `src/main.ts` with distinct schemes: session cookie (`session_token`), session bearer (`session_bearer`), and API-key bearer (`api_key`); keep Admin/public tags and non-envelope boundary description
- [x] 1.2 Apply `@ApiCookieAuth` / `@ApiBearerAuth` (or equivalent) on Nest controllers that accept session and/or API-key credentials; ensure public, health, metrics, and Stripe webhook routes are not marked as requiring those schemes
- [x] 1.3 Add a focused unit or e2e assertion that the generated OpenAPI document lists the three schemes and that an admin route remains `Admin`-tagged

## 2. Makefile / scripted workflows

- [x] 2.1 Add root `Makefile` with `.PHONY` targets wrapping existing scripts: `up`, `down`, `logs`, `migrate`, `seed`, `lint`, `typecheck`, `test`, `test-e2e`, `test-smoke`, `build`, `image`, and `help` (default)
- [x] 2.2 Add optional `ci-local` target that chains lint → typecheck → unit → migrate → e2e → build → smoke without inventing new logic
- [x] 2.3 Verify `make help`, `make test`, and `make image` invoke the intended pnpm/Docker commands

## 3. Husky, lint-staged, conventional commits

- [x] 3.1 Add devDependencies: `husky`, `lint-staged`, `@commitlint/cli`, `@commitlint/config-conventional`; add `prepare` script to install Husky
- [x] 3.2 Configure lint-staged for staged `src/**/*.ts`, `test/**/*.ts`, `scripts/**/*.ts` (ESLint `--fix` / Prettier as already used)
- [x] 3.3 Add `.husky/pre-commit` (lint-staged) and `.husky/commit-msg` (commitlint); add `commitlint.config.*` extending conventional
- [x] 3.4 Manually verify: dirty lint on staged file blocks commit; `feat(dx): …` passes; `wip stuff` fails

## 4. README five-minute first run and sample env pointers

- [x] 4.1 Restructure README lead with a **5-minute first run** section (copy-paste commands → `/health/ready`); note seed requirement for authz
- [x] 4.2 Document Makefile targets alongside the Scripts table; document Husky / conventional commits and emergency bypass (`HUSKY=0` / `--no-verify`)
- [x] 4.3 Add explicit README pointers to `.env.example` sections for Google, Apple, Stripe, and Redis; tighten `.env.example` section comments only if a heading is unclear (no new env files)

## 5. GitHub Actions matrix and Docker image gate

- [x] 5.1 Update `.github/workflows/ci.yml` with a Node matrix including `22` and `24` (`fail-fast: false`); keep frozen lockfile, Postgres/Redis services, and gate order
- [x] 5.2 Run production `docker build --target runner` once on the primary matrix cell (Node 22); fail the workflow on image build failure
- [x] 5.3 Confirm CI still runs `pnpm test:e2e` after migrate + seed on each matrix cell

## 6. E2E coverage audit (auth, limits, credits, webhook)

- [x] 6.1 Audit `test/auth-surface.e2e-spec.ts` for sign-up → verify → sign-in; fill any happy-path gap
- [x] 6.2 Audit `test/usage-limits.e2e-spec.ts` for ceiling → enveloped rejection; fill any gap
- [x] 6.3 Audit `test/credits-stripe.e2e-spec.ts` for credit spend/guard and Stripe webhook grant + invalid signature rejection; fill any gap
- [x] 6.4 Run `pnpm test:e2e` locally against Compose Postgres/Redis and fix regressions from OpenAPI/decorator changes if any

## 7. Final verification

- [x] 7.1 Run `pnpm lint:ci`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e`
- [x] 7.2 Run `pnpm build` + `pnpm test:smoke` and `make image` (or equivalent docker build)
- [x] 7.3 Spot-check Swagger UI Authorize options when `SWAGGER_ENABLED=true`
