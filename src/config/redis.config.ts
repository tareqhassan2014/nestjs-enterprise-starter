import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const redisConfig = registerAs('redis', () => {
  const env = getEnv();

  return {
    url: env.REDIS_URL,
    healthTimeoutMs: env.HEALTH_TIMEOUT_MS,
  };
});

export type RedisConfig = ReturnType<typeof redisConfig>;
