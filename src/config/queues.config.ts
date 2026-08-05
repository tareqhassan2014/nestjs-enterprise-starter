import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const QUEUE_NAMES = {
  EMAIL: 'email',
  WEBHOOKS_OUTBOUND: 'webhooks.outbound',
  USAGE_ROLLUPS: 'usage.rollups',
  /**
   * Retry path for a compensating credit refund whose inline attempt failed.
   *
   * Its own queue rather than reusing `webhooks.outbound`: that one is an outbound
   * delivery primitive, and overloading it would hide a money-correcting job
   * behind an unrelated name in the dashboard.
   */
  CREDIT_COMPENSATIONS: 'credits.compensations',
} as const;

export const queuesConfig = registerAs('queues', () => {
  const env = getEnv();

  return {
    prefix: env.BULLMQ_PREFIX,
    defaultAttempts: env.BULLMQ_DEFAULT_ATTEMPTS,
    backoffMs: env.BULLMQ_BACKOFF_MS,
    emailConcurrency: env.BULLMQ_EMAIL_CONCURRENCY,
    webhookConcurrency: env.BULLMQ_WEBHOOK_CONCURRENCY,
    usageRollupConcurrency: env.BULLMQ_USAGE_ROLLUP_CONCURRENCY,
    emailLowBalanceEnabled: env.EMAIL_LOW_BALANCE_ENABLED,
    usageRollupIntervalMs: env.USAGE_ROLLUP_INTERVAL_MS,
  };
});

export type QueuesConfig = ReturnType<typeof queuesConfig>;
