import { resetEnvCache, validateEnv } from './env.validation';

const validEnv = {
  DATABASE_URL:
    'postgresql://postgres:postgres@localhost:5432/app?schema=public',
  REDIS_URL: 'redis://localhost:6379',
};

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
});
