# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project

Enterprise-grade NestJS starter (open source template). Fork/clone for real apps.

Planned stack (scaffold may still be in progress):

- NestJS + Express, Prisma, PostgreSQL, Redis
- Better Auth: Google/Apple OAuth, 2FA/TOTP, strict RBAC
- Plans: Lite / Pro, monthly / yearly
- Redis throttling + daily/weekly usage limits
- Pay-as-you-go credits (ledger) + Stripe top-up
- Uniform request validation/transform + response envelope
- Admin monitoring APIs, Docker, CI, structured logging

## OpenSpec (Cursor + Claude Code)

This repo uses [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven changes.

- Specs live in `openspec/specs/`
- Changes live in `openspec/changes/`
- Config: `openspec/config.yaml`

**Cursor:** `/opsx-propose`, `/opsx-apply`, `/opsx-archive`, `/opsx-explore`, `/opsx-sync`, `/opsx-update`  
**Claude Code:** `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, `/opsx:explore`, `/opsx:sync`, `/opsx:update`

For non-trivial features, architecture shifts, or ambiguous work: propose → apply → archive. Do not skip specs for auth, billing, credits, or throttling changes.

## Working rules

- Prefer small, reviewable changes aligned with existing OpenSpec proposals
- Never commit secrets; use `.env.example` only
- Keep API responses in the shared envelope format once implemented
- Enforce auth → RBAC → plan entitlements → throttle/limits → credits (when applicable)
- Do not duplicate instructions into `CLAUDE.md` — that file only references this one
- **Never** add `Co-authored-by:` (or any co-author trailer) to git commit messages — no AI/tool co-authors
