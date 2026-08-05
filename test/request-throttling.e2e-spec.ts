import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { throttleConfig, type ThrottleConfig } from '@config/throttle.config';
import { redisConfig } from '@config/redis.config';
import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import { clearAuthLimiterState, createVerifiedUser } from './auth-helpers';
import { createTestApp } from './create-test-app';
import { ContractFixtureModule } from './fixtures/contract-fixture.module';

const BURST_MAX = 3;
const MINUTE_MAX = 20;
const STRICT_BURST_MAX = 2;

/**
 * Integration test: requires Compose Redis.
 *
 * Uses its own Redis DB and tight ceilings so parallel suites with generous
 * `.env.test` limits cannot poison these counters.
 */
describe('Request throttling (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    del: (...keys: string[]) => Promise<number>;
    quit: () => Promise<string>;
    disconnect: () => void;
  };

  beforeAll(async () => {
    const tightened: ThrottleConfig = {
      ...throttleConfig(),
      burst: { windowSeconds: 30, max: BURST_MAX },
      minute: { windowSeconds: 60, max: MINUTE_MAX },
      strict: {
        burst: { windowSeconds: 30, max: STRICT_BURST_MAX },
        minute: { windowSeconds: 60, max: 10 },
      },
    };

    app = await createTestApp(
      (builder) =>
        builder
          .overrideProvider(throttleConfig.KEY)
          .useValue(tightened)
          .overrideProvider(redisConfig.KEY)
          .useValue({ ...redisConfig(), url: `${redisConfig().url}/10` }),
      [ContractFixtureModule],
    );

    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    redis = app.get(REDIS_CLIENT);
    await clearAuthLimiterState(redis);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  async function clearThrottleKeys(): Promise<void> {
    const keys = await redis.keys('throttle:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  beforeEach(clearThrottleKeys);

  const server = () => app.getHttpServer();

  it('returns 429 RATE_LIMITED with Retry-After after the burst ceiling', async () => {
    const statuses: number[] = [];

    for (let index = 0; index < BURST_MAX + 2; index += 1) {
      const response = await request(server()).get('/api/v1/fixture/object');
      statuses.push(response.status);

      if (response.status === 429) {
        expect(response.body.error.code).toBe('RATE_LIMITED');
        expect(response.headers['retry-after']).toMatch(/^\d+$/);
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      }
    }

    expect(statuses.filter((status) => status === 200).length).toBe(BURST_MAX);
    expect(statuses).toContain(429);
  });

  it('does not throttle health probes past the burst ceiling', async () => {
    for (let index = 0; index < BURST_MAX + 5; index += 1) {
      const response = await request(server()).get('/health/live');
      expect(response.status).toBe(200);
    }
  });

  it('does not apply Nest throttle counters to /api/auth/*', async () => {
    for (let index = 0; index < BURST_MAX + 2; index += 1) {
      await request(server()).get('/api/v1/fixture/object');
    }

    const auth = await request(server()).post('/api/auth/sign-in/email').send({
      email: 'nobody@example.test',
      password: 'wrong-password-entirely',
    });

    expect(auth.body?.error?.code).not.toBe('RATE_LIMITED');
    expect(auth.status).not.toBe(503);
  });

  it('ignores forged X-Forwarded-For when TRUST_PROXY is off', async () => {
    for (let index = 0; index < BURST_MAX + 1; index += 1) {
      await request(server())
        .get('/api/v1/fixture/object')
        .set('X-Forwarded-For', '203.0.113.9');
    }

    const blocked = await request(server())
      .get('/api/v1/fixture/object')
      .set('X-Forwarded-For', '198.51.100.2');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('applies a stricter burst ceiling on Nest account routes', async () => {
    expect(STRICT_BURST_MAX).toBeLessThan(BURST_MAX);

    const user = await createVerifiedUser(
      { app, prisma, mail },
      'throttle-strict',
    );

    const statuses: number[] = [];
    for (let index = 0; index < STRICT_BURST_MAX + 2; index += 1) {
      statuses.push(
        (
          await request(server())
            .get('/api/v1/account/me')
            .set('Cookie', user.cookie)
        ).status,
      );
    }

    expect(statuses.filter((status) => status === 200).length).toBe(
      STRICT_BURST_MAX,
    );
    expect(statuses).toContain(429);

    await prisma.user.delete({ where: { id: user.userId } });
  });

  /**
   * The strict and default policies must not share a counter.
   *
   * These cases need one tracker crossing both policies, which is why they sign in
   * rather than using the fixture route: `/api/v1/fixture/object` is `@Public()`,
   * so `AuthGuard` never publishes a principal and the tracker is `ip:…`, while
   * `/api/v1/account/me` tracks `user:…`. Different keys either way — so the
   * original bug was invisible to every existing case here.
   *
   * `GET /api/v1/billing/plan` is authenticated with the default policy;
   * `GET /api/v1/account/me` is authenticated and `@StrictThrottle()`. Same
   * tracker, different ceilings.
   */
  describe('policy counters are independent', () => {
    const asUser = (path: string, cookie: string) =>
      request(server()).get(path).set('Cookie', cookie);

    it('does not let default-policy traffic consume the strict allowance', async () => {
      const user = await createVerifiedUser(
        { app, prisma, mail },
        'throttle-policy-bleed',
      );

      try {
        // Enough default-policy calls to exceed the strict ceiling while staying
        // under the default one.
        expect(STRICT_BURST_MAX).toBeLessThan(BURST_MAX);
        for (let index = 0; index < BURST_MAX; index += 1) {
          const response = await asUser('/api/v1/billing/plan', user.cookie);
          expect(response.status).toBe(200);
        }

        /**
         * First strict-policy request for this caller. Under the shared counter it
         * arrived already over the strict ceiling — `429` before the caller had
         * made a single account-route call.
         */
        const strict = await asUser('/api/v1/account/me', user.cookie);
        expect(strict.status).toBe(200);
      } finally {
        await prisma.user.delete({ where: { id: user.userId } });
      }
    });

    it('does not let a strict block deny default-policy routes', async () => {
      const user = await createVerifiedUser(
        { app, prisma, mail },
        'throttle-policy-block',
      );

      try {
        // Exhaust the strict ceiling, which writes a block key.
        const strictStatuses: number[] = [];
        for (let index = 0; index < STRICT_BURST_MAX + 2; index += 1) {
          strictStatuses.push(
            (await asUser('/api/v1/account/me', user.cookie)).status,
          );
        }
        expect(strictStatuses).toContain(429);

        /**
         * The block key used to be policy-agnostic, so exceeding the account
         * ceiling denied every Nest route — a tighter limit on a sensitive surface
         * became a lever for locking the caller out of the whole API.
         */
        const defaultRoute = await asUser('/api/v1/billing/plan', user.cookie);
        expect(defaultRoute.status).toBe(200);
      } finally {
        await prisma.user.delete({ where: { id: user.userId } });
      }
    });
  });

  it('returns 503 SERVICE_UNAVAILABLE when Redis cannot serve throttle counters', async () => {
    await redis.quit().catch(() => undefined);
    redis.disconnect();

    const response = await request(server()).get('/api/v1/fixture/object');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
