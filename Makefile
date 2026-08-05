# Thin wrappers around package.json / Docker scripts. Prefer `pnpm <script>`
# when scripting; use `make <target>` for short local loops.
.DEFAULT_GOAL := help

.PHONY: help up down logs migrate seed lint typecheck test test-e2e test-smoke build image ci-local

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n" } \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  %-14s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Start Compose stack (app + Postgres + Redis + Mailpit)
	pnpm docker:up

down: ## Stop Compose stack
	pnpm docker:down

logs: ## Follow app container logs
	pnpm docker:logs

migrate: ## Apply Prisma migrations (deploy)
	pnpm db:migrate:deploy

seed: ## Seed permission catalogue, roles, and plans
	pnpm db:seed

lint: ## ESLint with --fix
	pnpm lint

typecheck: ## TypeScript --noEmit
	pnpm typecheck

test: ## Unit tests
	pnpm test

test-e2e: ## End-to-end / integration tests
	pnpm test:e2e

test-smoke: ## Boot smoke test of dist/main
	pnpm test:smoke

build: ## Compile to dist/
	pnpm build

image: ## Build production Docker image (runner stage)
	docker build --target runner -t nestjs-enterprise-starter:local .

ci-local: ## Best-effort local mirror of CI gates (needs Postgres + Redis)
	pnpm lint:ci
	pnpm typecheck
	pnpm test
	pnpm db:migrate:deploy
	pnpm test:e2e
	pnpm build
	pnpm test:smoke
