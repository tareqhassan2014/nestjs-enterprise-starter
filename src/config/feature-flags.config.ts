import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const featureFlagsConfig = registerAs('featureFlags', () => {
  const env = getEnv();

  return {
    /** Env defaults keyed by FeatureFlag id. */
    defaults: {
      'email.low_balance': env.FEATURE_FLAG_EMAIL_LOW_BALANCE,
      'org.billing': env.FEATURE_FLAG_ORG_BILLING,
    } as const,
  };
});

export type FeatureFlagsConfig = ReturnType<typeof featureFlagsConfig>;
