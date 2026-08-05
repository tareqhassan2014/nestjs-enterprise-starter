# syntax=docker/dockerfile:1

# Alpine is safe here because Prisma 7 ships a WASM query compiler with no
# native engine binary — the musl/OpenSSL binary-target problem that ruled it
# out under Prisma 6 no longer exists. A fork that adds native dependencies
# (bcrypt, sharp) may prefer node:22-bookworm-slim; see README.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies (all, including dev — needed to build)
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Production dependencies only
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# prepare runs husky; husky is a devDependency and absent in --prod installs.
RUN HUSKY=0 pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# Build: generate the Prisma client into src/, then compile src/ into dist/
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm db:generate && pnpm build

# ---------------------------------------------------------------------------
# Development: full toolchain, hot reload. Used by compose.dev.yaml.
# ---------------------------------------------------------------------------
FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm db:generate
EXPOSE 3000
CMD ["pnpm", "start:dev"]

# ---------------------------------------------------------------------------
# Runtime: production deps + compiled output only. No sources, no prisma CLI —
# the generated client was compiled into dist/ by the build stage.
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Migrations are deliberately not run here: N replicas starting at once would
# race the same migration. Run `pnpm db:migrate:deploy` as an explicit step.
CMD ["node", "dist/main"]
