import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const appConfig = registerAs('app', () => {
  const env = getEnv();

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
