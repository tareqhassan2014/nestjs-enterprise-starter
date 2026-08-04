import type { z } from 'zod';

import { type Env, envSchema } from './env.schema';

let cachedEnv: Env | undefined;

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const variable = issue.path.join('.') || '(root)';
    return `  - ${variable}: ${issue.message}`;
  });

  return [
    'Invalid environment configuration:',
    ...lines,
    '',
    'See .env.example for the full contract.',
  ].join('\n');
}

/**
 * Passed to `ConfigModule.forRoot({ validate })`. Reports *every* problem in one
 * error rather than the first, so a fresh clone learns about all of its missing
 * variables in a single run.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(formatIssues(result.error));
  }

  cachedEnv = result.data;
  return result.data;
}

/**
 * Validated environment for the config namespaces. Falls back to validating
 * `process.env` directly so a namespace factory resolved before (or without)
 * `ConfigModule` still gets validated, coerced values rather than raw strings.
 */
export function getEnv(): Env {
  cachedEnv ??= validateEnv(process.env);
  return cachedEnv;
}

/** Test-only: drop the memoised environment between cases. */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}
