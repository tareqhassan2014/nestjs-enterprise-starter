import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const shutdownConfig = registerAs('shutdown', () => {
  const env = getEnv();

  return {
    drainMs: env.SHUTDOWN_DRAIN_MS,
    organizationHeader: env.ORGANIZATION_HEADER.toLowerCase(),
  };
});

export type ShutdownConfig = ReturnType<typeof shutdownConfig>;
