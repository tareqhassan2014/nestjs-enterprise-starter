import { config as loadEnvFiles } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration. Replaces the `prisma` key in package.json, which no
 * longer exists.
 *
 * This file runs as CLI tooling outside the Nest container, so it is one of the
 * few places permitted to read process.env directly (see eslint.config.mjs).
 */
loadEnvFiles({ path: ['.env.local', '.env'], quiet: true });

/**
 * Deliberately not validated here. `prisma generate` needs no database, and it
 * runs during the Docker build where no DATABASE_URL exists — throwing at
 * import time would break the image build. Commands that do need a connection
 * report it themselves, and the application's own boot-time validation gives
 * the actionable error.
 */
const url = process.env.DATABASE_URL ?? '';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node -P tsconfig.scripts.json prisma/seed.ts',
  },
  datasource: {
    url,
  },
});
