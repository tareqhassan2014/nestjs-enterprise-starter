import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const databaseConfig = registerAs('database', () => {
  const env = getEnv();

  return {
    url: env.DATABASE_URL,
  };
});

export type DatabaseConfig = ReturnType<typeof databaseConfig>;
