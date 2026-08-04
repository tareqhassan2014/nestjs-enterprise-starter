import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

/**
 * Where Better Auth's own routes are served. Outside the `/api/v1` version
 * segment on the same reasoning that keeps `/health/*` outside it: the library
 * owns this route contract, so it must not move when our API version does.
 */
export const AUTH_BASE_PATH = '/api/auth';

export const authConfig = registerAs('auth', () => {
  const env = getEnv();

  /**
   * Derived from which credential groups are present, never from a separate
   * enable flag — so configuration cannot contradict itself. The schema has
   * already rejected any half-supplied group.
   */
  const socialProviders = {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
      ? {
          apple: {
            clientId: env.APPLE_CLIENT_ID,
            clientSecret: env.APPLE_CLIENT_SECRET,
          },
        }
      : {}),
  };

  return {
    secret: env.BETTER_AUTH_SECRET,
    appUrl: env.APP_URL,
    basePath: AUTH_BASE_PATH,

    session: {
      expiresInSeconds: env.SESSION_EXPIRES_IN_SECONDS,
      updateAgeSeconds: env.SESSION_UPDATE_AGE_SECONDS,
    },

    password: {
      minLength: env.AUTH_MIN_PASSWORD_LENGTH,
      maxLength: env.AUTH_MAX_PASSWORD_LENGTH,
    },

    tokens: {
      verificationTtlSeconds: env.AUTH_VERIFICATION_TOKEN_TTL_SECONDS,
      resetTtlSeconds: env.AUTH_RESET_TOKEN_TTL_SECONDS,
    },

    totpIssuer: env.AUTH_TOTP_ISSUER,

    socialProviders,
    enabledProviders: Object.keys(socialProviders),

    rateLimit: {
      windowSeconds: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      max: env.AUTH_RATE_LIMIT_MAX,
      strictWindowSeconds: env.AUTH_STRICT_RATE_LIMIT_WINDOW_SECONDS,
      strictMax: env.AUTH_STRICT_RATE_LIMIT_MAX,
    },

    lockout: {
      threshold: env.AUTH_LOCKOUT_THRESHOLD,
      baseDelaySeconds: env.AUTH_LOCKOUT_BASE_DELAY_SECONDS,
      maxDelaySeconds: env.AUTH_LOCKOUT_MAX_DELAY_SECONDS,
      windowSeconds: env.AUTH_LOCKOUT_WINDOW_SECONDS,
    },
  };
});

export type AuthConfig = ReturnType<typeof authConfig>;
