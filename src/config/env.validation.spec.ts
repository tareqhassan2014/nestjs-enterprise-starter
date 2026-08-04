import { PLACEHOLDER_AUTH_SECRET } from './env.schema';
import { resetEnvCache, validateEnv } from './env.validation';

const validEnv = {
  DATABASE_URL:
    'postgresql://postgres:postgres@localhost:5432/app?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-thirty-two-chars',
  APP_URL: 'http://localhost:3000',
};

/** Drops one variable, to assert that its absence is what fails validation. */
function without<K extends keyof typeof validEnv>(
  key: K,
): Omit<typeof validEnv, K> {
  const copy: Partial<typeof validEnv> = { ...validEnv };
  delete copy[key];
  return copy as Omit<typeof validEnv, K>;
}

describe('validateEnv', () => {
  afterEach(() => {
    resetEnvCache();
  });

  it('accepts a complete environment and applies documented defaults', () => {
    const env = validateEnv({ ...validEnv });

    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.HOST).toBe('0.0.0.0');
  });

  it('coerces numeric variables supplied as strings', () => {
    const env = validateEnv({ ...validEnv, PORT: '8080' });

    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it('ignores variables the schema does not declare', () => {
    const env = validateEnv({ ...validEnv, SOME_UNRELATED_TOOL_FLAG: 'true' });

    expect(env).not.toHaveProperty('SOME_UNRELATED_TOOL_FLAG');
  });

  it('reports every failing variable in a single error', () => {
    const broken = { REDIS_URL: validEnv.REDIS_URL, PORT: 'not-a-number' };

    expect(() => validateEnv(broken)).toThrow(/DATABASE_URL/);
    expect(() => validateEnv(broken)).toThrow(/PORT/);

    // One error carrying both, rather than failing on the first problem.
    let message = '';
    try {
      validateEnv(broken);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('PORT');
  });

  it('fails when a connection string is missing, with no default applied', () => {
    expect(() => validateEnv({ REDIS_URL: validEnv.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a connection string with the wrong scheme', () => {
    expect(() =>
      validateEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost:3306/app' }),
    ).toThrow(/PostgreSQL/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ ...validEnv, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an unknown log level', () => {
    expect(() => validateEnv({ ...validEnv, LOG_LEVEL: 'chatty' })).toThrow(
      /LOG_LEVEL/,
    );
  });

  describe('authentication secret', () => {
    it('fails when the signing secret is absent, with no default applied', () => {
      expect(() => validateEnv(without('BETTER_AUTH_SECRET'))).toThrow(
        /BETTER_AUTH_SECRET/,
      );
    });

    it('fails when the signing secret is shorter than the minimum', () => {
      let message = '';
      try {
        validateEnv({ ...validEnv, BETTER_AUTH_SECRET: 'a'.repeat(20) });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('BETTER_AUTH_SECRET');
      expect(message).toMatch(/32/);
    });

    it('rejects the .env.example placeholder in production', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          NODE_ENV: 'production',
          MAIL_TRANSPORT: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: '587',
          SMTP_USER: 'mailer',
          SMTP_PASSWORD: 'secret',
          BETTER_AUTH_SECRET: PLACEHOLDER_AUTH_SECRET,
        }),
      ).toThrow(/placeholder/i);
    });

    it('accepts the placeholder outside production, so a fresh clone boots', () => {
      const env = validateEnv({
        ...validEnv,
        BETTER_AUTH_SECRET: PLACEHOLDER_AUTH_SECRET,
      });

      expect(env.BETTER_AUTH_SECRET).toBe(PLACEHOLDER_AUTH_SECRET);
    });
  });

  describe('conditionally required credential groups', () => {
    it('accepts a group that is absent entirely', () => {
      const env = validateEnv({ ...validEnv });

      expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
      expect(env.APPLE_CLIENT_ID).toBeUndefined();
    });

    it('accepts a group that is supplied completely', () => {
      const env = validateEnv({
        ...validEnv,
        GOOGLE_CLIENT_ID: 'google-id',
        GOOGLE_CLIENT_SECRET: 'google-secret',
      });

      expect(env.GOOGLE_CLIENT_ID).toBe('google-id');
    });

    it('fails a half-supplied group, naming the missing variable and its group', () => {
      let message = '';
      try {
        validateEnv({ ...validEnv, GOOGLE_CLIENT_ID: 'google-id' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('GOOGLE_CLIENT_SECRET');
      expect(message).toContain('Google OAuth');
    });

    it('reports two half-supplied groups in one aggregated error', () => {
      let message = '';
      try {
        validateEnv({
          ...validEnv,
          GOOGLE_CLIENT_ID: 'google-id',
          APPLE_CLIENT_SECRET: 'apple-secret',
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('GOOGLE_CLIENT_SECRET');
      expect(message).toContain('APPLE_CLIENT_ID');
    });

    it('treats a blank assignment as absent, so `cp .env.example .env` boots', () => {
      const env = validateEnv({
        ...validEnv,
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        SMTP_HOST: '',
        SMTP_PORT: '',
      });

      expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
      expect(env.SMTP_PORT).toBeUndefined();
    });
  });

  describe('cross-origin configuration', () => {
    it('parses a comma-separated allowlist', () => {
      const env = validateEnv({
        ...validEnv,
        CORS_ORIGINS: 'http://localhost:5173, https://app.example.com',
      });

      expect(env.CORS_ORIGINS).toEqual([
        'http://localhost:5173',
        'https://app.example.com',
      ]);
    });

    it('defaults to an empty allowlist', () => {
      expect(validateEnv({ ...validEnv }).CORS_ORIGINS).toEqual([]);
    });

    it('rejects a wildcard origin, which credentialed CORS cannot use', () => {
      expect(() => validateEnv({ ...validEnv, CORS_ORIGINS: '*' })).toThrow(
        /CORS_ORIGINS/,
      );
    });

    it('rejects an origin carrying a path', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          CORS_ORIGINS: 'https://app.example.com/callback',
        }),
      ).toThrow(/bare origin/);
    });

    it('rejects a malformed origin, naming the offending value', () => {
      expect(() =>
        validateEnv({ ...validEnv, CORS_ORIGINS: 'not-an-origin' }),
      ).toThrow(/not-an-origin/);
    });
  });

  describe('boolean flags', () => {
    it('reads "false" as false rather than as a truthy string', () => {
      expect(
        validateEnv({ ...validEnv, TRUST_PROXY: 'false' }).TRUST_PROXY,
      ).toBe(false);
    });

    it('reads "true" as true and defaults to off', () => {
      expect(
        validateEnv({ ...validEnv, TRUST_PROXY: 'true' }).TRUST_PROXY,
      ).toBe(true);
      expect(validateEnv({ ...validEnv }).TRUST_PROXY).toBe(false);
    });
  });

  describe('mail transport', () => {
    it('rejects the recording transport in production', () => {
      let message = '';
      try {
        validateEnv({
          ...validEnv,
          NODE_ENV: 'production',
          MAIL_TRANSPORT: 'log',
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('MAIL_TRANSPORT');
      expect(message).toMatch(/production/);
    });

    it('accepts the recording transport in development', () => {
      const env = validateEnv({
        ...validEnv,
        NODE_ENV: 'development',
        MAIL_TRANSPORT: 'log',
      });

      expect(env.MAIL_TRANSPORT).toBe('log');
    });

    it('requires the SMTP group when the SMTP transport is selected', () => {
      let message = '';
      try {
        validateEnv({ ...validEnv, MAIL_TRANSPORT: 'smtp' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('SMTP_HOST');
      expect(message).toContain('SMTP_PASSWORD');
    });

    it('accepts a complete SMTP group', () => {
      const env = validateEnv({
        ...validEnv,
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'mailer',
        SMTP_PASSWORD: 'secret',
      });

      expect(env.SMTP_PORT).toBe(587);
    });

    it('rejects an unknown transport, naming the accepted values', () => {
      expect(() =>
        validateEnv({ ...validEnv, MAIL_TRANSPORT: 'carrier-pigeon' }),
      ).toThrow(/MAIL_TRANSPORT/);
    });
  });

  describe('rate-limit invariants', () => {
    it('requires the credential paths to be stricter than the general surface', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          AUTH_RATE_LIMIT_MAX: '10',
          AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
          AUTH_STRICT_RATE_LIMIT_MAX: '100',
          AUTH_STRICT_RATE_LIMIT_WINDOW_SECONDS: '60',
        }),
      ).toThrow(/AUTH_STRICT_RATE_LIMIT_MAX/);
    });

    it('accepts the shipped defaults', () => {
      const env = validateEnv({ ...validEnv });

      expect(env.AUTH_STRICT_RATE_LIMIT_MAX).toBe(10);
      expect(env.AUTH_RATE_LIMIT_MAX).toBe(60);
    });

    it('rejects a base lockout delay above the cap', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          AUTH_LOCKOUT_BASE_DELAY_SECONDS: '1000',
          AUTH_LOCKOUT_MAX_DELAY_SECONDS: '100',
        }),
      ).toThrow(/AUTH_LOCKOUT_BASE_DELAY_SECONDS/);
    });
  });

  describe('application URL', () => {
    it('fails when absent, so verification links cannot point at a guess', () => {
      expect(() => validateEnv(without('APP_URL'))).toThrow(/APP_URL/);
    });

    it('rejects a non-http scheme', () => {
      expect(() =>
        validateEnv({ ...validEnv, APP_URL: 'ftp://example.com' }),
      ).toThrow(/APP_URL/);
    });
  });
});
