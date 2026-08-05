import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

/**
 * Credits-specific settings that are independent of whether Stripe is enabled.
 * The ledger always works; Stripe is only the paid top-up ingress.
 */
export const creditsConfig = registerAs('credits', () => {
  const env = getEnv();

  return {
    lowBalanceThreshold: env.CREDITS_LOW_BALANCE_THRESHOLD,
  };
});

export type CreditsConfig = ReturnType<typeof creditsConfig>;
