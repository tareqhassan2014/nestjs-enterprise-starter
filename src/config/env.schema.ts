import { z } from 'zod';

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('postgresql://') || value.startsWith('postgres://'),
    { message: 'must be a PostgreSQL connection string (postgresql://…)' },
  );

const redisUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
    { message: 'must be a Redis connection string (redis://… or rediss://…)' },
  );

/**
 * The single source of truth for every environment variable the application
 * reads. Anything not declared here is ignored, and `.env.example` is checked
 * against this schema in CI (`pnpm check:env`).
 *
 * Defaults are only permitted for values that are safe to default. Secrets and
 * connection strings deliberately have none, so their absence fails the boot.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  /** Per-dependency timeout for readiness checks, so a hung dependency cannot hang the probe. */
  HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
});

export type Env = z.infer<typeof envSchema>;
