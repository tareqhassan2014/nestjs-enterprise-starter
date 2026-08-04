import { throttleConfig } from './throttle.config';
import { usageLimitsConfig } from './usage-limits.config';
import { resetEnvCache, validateEnv } from './env.validation';

const validEnv = {
  DATABASE_URL:
    'postgresql://postgres:postgres@localhost:5432/app?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'a-secret-that-is-at-least-thirty-two-chars',
  APP_URL: 'http://localhost:3000',
  THROTTLE_BURST_MAX: '15',
  THROTTLE_BURST_WINDOW_SECONDS: '5',
  THROTTLE_MINUTE_MAX: '90',
  THROTTLE_MINUTE_WINDOW_SECONDS: '60',
  THROTTLE_STRICT_BURST_MAX: '5',
  THROTTLE_STRICT_BURST_WINDOW_SECONDS: '5',
  THROTTLE_STRICT_MINUTE_MAX: '30',
  THROTTLE_STRICT_MINUTE_WINDOW_SECONDS: '60',
  USAGE_LIMIT_DEFAULT_DAILY: '50',
  USAGE_LIMIT_DEFAULT_WEEKLY: '200',
  USAGE_LIMIT_DEMO_DAILY: '10',
  USAGE_LIMIT_DEMO_WEEKLY: '40',
};

describe('throttle and usage config namespaces', () => {
  afterEach(() => {
    resetEnvCache();
  });

  it('exposes coerced throttle numbers through the typed namespace', () => {
    validateEnv({ ...validEnv });
    const config = throttleConfig();

    expect(config.burst.max).toBe(15);
    expect(config.burst.windowSeconds).toBe(5);
    expect(config.strict.minute.max).toBe(30);
    expect(typeof config.burst.max).toBe('number');
  });

  it('exposes coerced usage ceilings through the typed namespace', () => {
    validateEnv({ ...validEnv });
    const config = usageLimitsConfig();

    expect(config.default.daily).toBe(50);
    expect(config.features.demo.weekly).toBe(40);
  });
});
