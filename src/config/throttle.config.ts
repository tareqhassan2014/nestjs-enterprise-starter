import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const throttleConfig = registerAs('throttle', () => {
  const env = getEnv();

  return {
    burst: {
      windowSeconds: env.THROTTLE_BURST_WINDOW_SECONDS,
      max: env.THROTTLE_BURST_MAX,
    },
    minute: {
      windowSeconds: env.THROTTLE_MINUTE_WINDOW_SECONDS,
      max: env.THROTTLE_MINUTE_MAX,
    },
    strict: {
      burst: {
        windowSeconds: env.THROTTLE_STRICT_BURST_WINDOW_SECONDS,
        max: env.THROTTLE_STRICT_BURST_MAX,
      },
      minute: {
        windowSeconds: env.THROTTLE_STRICT_MINUTE_WINDOW_SECONDS,
        max: env.THROTTLE_STRICT_MINUTE_MAX,
      },
    },
  };
});

export type ThrottleConfig = ReturnType<typeof throttleConfig>;
