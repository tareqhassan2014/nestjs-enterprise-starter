import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const idempotencyConfig = registerAs('idempotency', () => {
  const env = getEnv();

  return {
    ttlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
    keyMaxLength: env.IDEMPOTENCY_KEY_MAX_LENGTH,
  };
});

export type IdempotencyConfig = ReturnType<typeof idempotencyConfig>;
