import { authConfig } from './auth.config';
import { resetEnvCache } from './env.validation';
import { securityConfig } from './security.config';

const BASE_ENV = {
  DATABASE_URL:
    'postgresql://postgres:postgres@localhost:5432/app?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-thirty-two-chars',
  APP_URL: 'http://localhost:3000',
};

/**
 * These namespaces derive values rather than reading them straight through, so
 * the derivation is what is worth testing: which providers are enabled, and
 * whether cookies are marked `Secure`. Both are deliberately *not* separately
 * configurable, because a second switch could only ever disagree.
 */
function withEnv(overrides: Record<string, string>, assert: () => void): void {
  const original = { ...process.env };

  try {
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('GOOGLE_') ||
        key.startsWith('APPLE_') ||
        key === 'APP_URL'
      ) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, BASE_ENV, overrides);
    resetEnvCache();
    assert();
  } finally {
    process.env = original;
    resetEnvCache();
  }
}

describe('authConfig', () => {
  it('enables no social provider when no credentials are supplied', () => {
    withEnv({}, () => {
      const config = authConfig();

      expect(config.enabledProviders).toEqual([]);
      expect(config.socialProviders).toEqual({});
    });
  });

  it('enables only the provider whose credential group is complete', () => {
    withEnv(
      { GOOGLE_CLIENT_ID: 'google-id', GOOGLE_CLIENT_SECRET: 'google-secret' },
      () => {
        const config = authConfig();

        expect(config.enabledProviders).toEqual(['google']);
        expect(config.socialProviders).toHaveProperty('google');
        expect(config.socialProviders).not.toHaveProperty('apple');
      },
    );
  });

  it('enables both providers when both groups are complete', () => {
    withEnv(
      {
        GOOGLE_CLIENT_ID: 'google-id',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        APPLE_CLIENT_ID: 'apple-id',
        APPLE_CLIENT_SECRET: 'apple-secret',
      },
      () => {
        expect(authConfig().enabledProviders.sort()).toEqual([
          'apple',
          'google',
        ]);
      },
    );
  });

  it('serves the auth surface outside the versioned prefix', () => {
    withEnv({}, () => {
      expect(authConfig().basePath).toBe('/api/auth');
    });
  });
});

describe('securityConfig', () => {
  it('marks the deployment as plain HTTP when APP_URL is http', () => {
    withEnv({ APP_URL: 'http://localhost:3000' }, () => {
      expect(securityConfig().servesHttps).toBe(false);
    });
  });

  it('marks the deployment as HTTPS when APP_URL is https', () => {
    withEnv({ APP_URL: 'https://api.example.com' }, () => {
      expect(securityConfig().servesHttps).toBe(true);
    });
  });
});
