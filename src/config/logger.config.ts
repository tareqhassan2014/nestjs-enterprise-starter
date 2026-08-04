import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const loggerConfig = registerAs('logger', () => {
  const env = getEnv();

  return {
    level: env.LOG_LEVEL,
    /**
     * Pretty output is a development affordance only. `pino-pretty` is a
     * devDependency and must never be resolved in the production image.
     *
     * Excluded under `test` as well as `production`: the pretty transport runs
     * in a worker thread, which leaks open handles across a Jest run.
     */
    pretty: env.NODE_ENV === 'development',
  };
});

export type LoggerConfig = ReturnType<typeof loggerConfig>;
