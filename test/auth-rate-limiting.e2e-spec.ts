import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { authConfig, type AuthConfig } from '@config/auth.config';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { redisConfig } from '@config/redis.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { AccountLockoutService } from '@modules/auth/account-lockout.service';

import { TEST_PASSWORD, uniqueEmail } from './auth-helpers';
import { createTestApp } from './create-test-app';

/** Tight enough to trip quickly, loose enough to leave room to observe. */
const GENERAL_MAX = 40;
const STRICT_MAX = 4;
const LOCKOUT_THRESHOLD = 3;

/**
 * Integration test: requires the Compose stack.
 *
 * Builds the app with its own limits rather than the environment's, because the
 * shared test environment deliberately uses generous ones so that suites which
 * are not about throttling do not get throttled.
 */
describe('Auth rate limiting and account lockout (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let lockout: AccountLockoutService;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    del: (...keys: string[]) => Promise<number>;
    get: (key: string) => Promise<string | null>;
  };

  const createdEmails: string[] = [];

  beforeAll(async () => {
    const tightened: AuthConfig = {
      ...authConfig(),
      rateLimit: {
        windowSeconds: 60,
        max: GENERAL_MAX,
        strictWindowSeconds: 60,
        strictMax: STRICT_MAX,
      },
      lockout: {
        threshold: LOCKOUT_THRESHOLD,
        baseDelaySeconds: 2,
        maxDelaySeconds: 8,
        windowSeconds: 30,
      },
    };

    /**
     * Also redirected to its own Redis logical database.
     *
     * Rate-limit counters are keyed `<ip>|<path>` with no prefix and no notion of
     * which app wrote them. Every e2e suite signs in from the same address, and
     * Jest runs them in parallel — so without isolation, requests made by other
     * suites (which run under the environment's deliberately generous limits)
     * increment the very counters this suite evaluates against a max of four, and
     * every request here returns `429` before reaching a handler.
     */
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(authConfig.KEY)
        .useValue(tightened)
        .overrideProvider(redisConfig.KEY)
        .useValue({ ...redisConfig(), url: `${redisConfig().url}/9` }),
    );

    prisma = app.get(PrismaService);
    lockout = app.get(AccountLockoutService);
    redis = app.get(REDIS_CLIENT);
  }, 60_000);

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    await app.close();
  });

  /**
   * Limits are shared state, so each case starts from a clean keyspace.
   *
   * The library stores rate-limit counters under a bare `<ip>|<path>` key with no
   * prefix (`createRateLimitKey` in `better-auth/dist/api/rate-limiter`), so
   * `*|/*` is what matches them. Getting this wrong is silent and confusing: the
   * limiter stays exhausted from an earlier case, every request returns `429`
   * before reaching the handler, and lockout assertions fail for a reason that
   * has nothing to do with lockout.
   */
  async function clearLimiterState(): Promise<void> {
    for (const pattern of ['auth:lockout:*', '*|/*']) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  }

  beforeEach(clearLimiterState);

  const signIn = (email: string, password = 'wrong-password-entirely') =>
    request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .send({ email, password });

  async function attempt(email: string, times: number): Promise<number[]> {
    const statuses: number[] = [];

    for (let index = 0; index < times; index += 1) {
      statuses.push((await signIn(email)).status);
    }

    return statuses;
  }

  describe('credential endpoints are limited', () => {
    it('rejects further attempts with 429 once the strict limit is exceeded', async () => {
      const email = uniqueEmail('rl-strict');
      const statuses = await attempt(email, STRICT_MAX + 3);

      expect(statuses).toContain(429);
    });

    it('tells the client how long to wait', async () => {
      const email = uniqueEmail('rl-retry');
      await attempt(email, STRICT_MAX + 3);

      const limited = await signIn(email);

      expect(limited.status).toBe(429);

      const retryAfter =
        limited.headers['retry-after'] ??
        (limited.body as { retryAfter?: unknown }).retryAfter;

      expect(retryAfter).toBeDefined();
    });

    it('leaves non-authentication routes serving', async () => {
      const email = uniqueEmail('rl-isolated');
      await attempt(email, STRICT_MAX + 3);

      // The auth surface is limited; the rest of the API is untouched.
      await expect(
        request(app.getHttpServer())
          .get('/health/live')
          .then((r) => r.status),
      ).resolves.toBe(200);

      const protectedRoute = await request(app.getHttpServer()).get(
        '/api/v1/account/two-factor',
      );
      expect(protectedRoute.status).toBe(401);
    });

    it('applies a stricter rate to credential paths than to the rest', () => {
      const config = app.get<AuthConfig>(authConfig.KEY);

      const general = config.rateLimit.max / config.rateLimit.windowSeconds;
      const strict =
        config.rateLimit.strictMax / config.rateLimit.strictWindowSeconds;

      expect(strict).toBeLessThan(general);
    });
  });

  describe('per-account lockout', () => {
    it('trips on repeated failures against one account', async () => {
      const email = uniqueEmail('lockout-trip');

      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await lockout.recordFailure(email);
      }

      const decision = await lockout.check(email);

      expect(decision.locked).toBe(true);
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('refuses a locked account through the HTTP surface', async () => {
      const email = uniqueEmail('lockout-http');

      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await lockout.recordFailure(email);
      }

      const response = await signIn(email);

      expect(response.status).toBe(429);
    });

    it('grows the required wait as failures continue, up to the cap', async () => {
      const email = uniqueEmail('lockout-backoff');
      const delays: number[] = [];

      for (let index = 0; index < LOCKOUT_THRESHOLD + 6; index += 1) {
        const decision = await lockout.recordFailure(email);
        if (decision.locked) {
          delays.push(decision.retryAfterSeconds);
        }
      }

      // Strictly increasing at first…
      expect(delays[1]).toBeGreaterThan(delays[0]);
      // …and never past the configured ceiling.
      expect(Math.max(...delays)).toBe(8);
    });

    it('counts by account, so failures from many addresses still trip it', async () => {
      const email = uniqueEmail('lockout-distributed');

      // Each attempt claims a different forwarded address. With TRUST_PROXY off
      // these are ignored for addressing, and the account counter is what bites.
      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await request(app.getHttpServer())
          .post('/api/auth/sign-in/email')
          .set('X-Forwarded-For', `203.0.113.${index + 1}`)
          .send({ email, password: 'wrong-password-entirely' });
      }

      const decision = await lockout.check(email);
      expect(decision.locked).toBe(true);
    });

    it('self-heals: the counter carries a TTL and needs no admin unlock', async () => {
      const email = uniqueEmail('lockout-ttl');

      await lockout.recordFailure(email);

      const keys = await redis.keys('auth:lockout:*');
      expect(keys.length).toBeGreaterThan(0);

      const client = redis as unknown as {
        ttl: (key: string) => Promise<number>;
      };
      const ttls = await Promise.all(keys.map((key) => client.ttl(key)));

      // A positive TTL is what makes the lock temporary rather than sticky.
      expect(Math.max(...ttls)).toBeGreaterThan(0);
    });

    it('clears the counter on a successful sign-in', async () => {
      const email = uniqueEmail('lockout-clear');

      await lockout.recordFailure(email);
      await lockout.recordFailure(email);

      await lockout.clear(email);

      const decision = await lockout.check(email);
      expect(decision.locked).toBe(false);
      expect(decision.retryAfterSeconds).toBe(0);
    });
  });

  describe('reveals nothing about which accounts exist', () => {
    it('consumes counters for an unregistered identifier too', async () => {
      const absent = uniqueEmail('absent-never-registered');

      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await lockout.recordFailure(absent);
      }

      // The limiter cannot be used as an existence oracle.
      const decision = await lockout.check(absent);
      expect(decision.locked).toBe(true);
    });

    it('permits the same number of attempts for present and absent addresses', async () => {
      const absent = uniqueEmail('compare-absent');
      const absentStatuses = await attempt(absent, STRICT_MAX + 2);

      await clearLimiterState();

      const present = uniqueEmail('compare-present');
      createdEmails.push(present);
      await request(app.getHttpServer())
        .post('/api/auth/sign-up/email')
        .send({ email: present, password: TEST_PASSWORD, name: 'Present' });

      const presentStatuses = await attempt(present, STRICT_MAX + 2);

      const countLimited = (statuses: number[]) =>
        statuses.filter((status) => status === 429).length;

      expect(countLimited(presentStatuses)).toBe(countLimited(absentStatuses));
    });
  });

  describe('rate-limit identity is not client-controlled', () => {
    it('ignores a forged forwarded address when proxy trust is off', async () => {
      const email = uniqueEmail('forge');

      // Exhaust the strict limit from the real address.
      await attempt(email, STRICT_MAX + 3);

      // A forged header must not buy a fresh allowance.
      const forged = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('X-Forwarded-For', '198.51.100.42')
        .send({ email, password: 'wrong-password-entirely' });

      expect(forged.status).toBe(429);
    });
  });

  describe('counter keys hold no raw addresses', () => {
    it('stores a hash rather than the identifier', async () => {
      const email = uniqueEmail('hashed');

      await lockout.recordFailure(email);

      const keys = await redis.keys('auth:lockout:*');

      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain(email);
        expect(key).not.toContain('@');
      }
    });

    it('shares one counter across case variants of an address', async () => {
      const email = uniqueEmail('CaseVariant');

      await lockout.recordFailure(email.toLowerCase());
      await lockout.recordFailure(email.toUpperCase());

      const keys = await redis.keys('auth:lockout:*');
      expect(keys).toHaveLength(1);

      const value = await redis.get(keys[0]);
      expect(value).toBe('2');
    });
  });
});
