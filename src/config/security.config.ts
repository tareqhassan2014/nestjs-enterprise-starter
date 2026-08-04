import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const securityConfig = registerAs('security', () => {
  const env = getEnv();

  /**
   * Taken from `APP_URL`'s scheme rather than from a flag of its own. The
   * question "are we reachable over HTTPS?" has exactly one true answer, and a
   * separate variable could only ever disagree with it. Drives both the
   * `Secure` cookie attribute and whether HSTS is emitted.
   */
  const servesHttps = new URL(env.APP_URL).protocol === 'https:';

  return {
    /**
     * Shared by CORS and the auth library's trusted-origin (CSRF) check. Two
     * lists would drift, and drift means either a CSRF hole or an inexplicable
     * rejection of a correctly configured client.
     */
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    servesHttps,
  };
});

export type SecurityConfig = ReturnType<typeof securityConfig>;
