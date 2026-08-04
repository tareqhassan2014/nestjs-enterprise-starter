import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

/**
 * Daily/weekly ceilings per catalogue feature. Features without an override
 * inherit `default`. Plan-based overrides belong to a later change.
 */
export const usageLimitsConfig = registerAs('usageLimits', () => {
  const env = getEnv();

  return {
    default: {
      daily: env.USAGE_LIMIT_DEFAULT_DAILY,
      weekly: env.USAGE_LIMIT_DEFAULT_WEEKLY,
    },
    features: {
      demo: {
        daily: env.USAGE_LIMIT_DEMO_DAILY,
        weekly: env.USAGE_LIMIT_DEMO_WEEKLY,
      },
    },
  };
});

export type UsageLimitsConfig = ReturnType<typeof usageLimitsConfig>;
