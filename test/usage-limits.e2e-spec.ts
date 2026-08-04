import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import {
  usageLimitsConfig,
  type UsageLimitsConfig,
} from '@config/usage-limits.config';
import { redisConfig } from '@config/redis.config';
import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { UsageLimitsService } from '@modules/usage-limits/usage-limits.service';
import { USAGE_FEATURES } from '@modules/usage-limits/usage-features';
import { ErrorCode } from '@common/errors/error-code';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';
import { UsageFixtureModule } from './fixtures/usage-fixture.module';

const DAILY = 3;
const WEEKLY = 5;

describe('Usage limits (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    del: (...keys: string[]) => Promise<number>;
    quit: () => Promise<string>;
    disconnect: () => void;
  };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const tightened: UsageLimitsConfig = {
      default: { daily: DAILY, weekly: WEEKLY },
      features: {
        demo: { daily: DAILY, weekly: WEEKLY },
      },
    };

    app = await createTestApp(
      (builder) =>
        builder
          .overrideProvider(usageLimitsConfig.KEY)
          .useValue(tightened)
          .overrideProvider(redisConfig.KEY)
          .useValue({ ...redisConfig(), url: `${redisConfig().url}/11` }),
      [UsageFixtureModule],
    );

    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    redis = app.get(REDIS_CLIENT);

    await clearAuthLimiterState(redis);
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  async function clearUsageKeys(): Promise<void> {
    const keys = await redis.keys('usage:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  beforeEach(clearUsageKeys);

  const server = () => app.getHttpServer();

  async function freshUser(label: string): Promise<TestUser> {
    const user = await createVerifiedUser({ app, prisma, mail }, label);
    createdUserIds.push(user.userId);
    return user;
  }

  it('returns 429 USAGE_LIMIT_EXCEEDED with Retry-After after the daily ceiling', async () => {
    const user = await freshUser('usage-daily');

    for (let index = 0; index < DAILY; index += 1) {
      const ok = await request(server())
        .get('/api/v1/fixture/metered')
        .set('Cookie', user.cookie);
      expect(ok.status).toBe(200);
    }

    const blocked = await request(server())
      .get('/api/v1/fixture/metered')
      .set('Cookie', user.cookie);

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('USAGE_LIMIT_EXCEEDED');
    expect(blocked.body.error.details).toMatchObject({
      feature: 'demo',
      period: 'day',
    });
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(blocked.body.error.code).not.toBe('RATE_LIMITED');
  });

  it('rejects when the weekly ceiling is exhausted (service + Redis)', async () => {
    const user = await freshUser('usage-weekly');
    const usage = app.get(UsageLimitsService);

    for (let index = 0; index < WEEKLY; index += 1) {
      await usage.consume({ userId: user.userId }, USAGE_FEATURES.DEMO, [
        'week',
      ]);
    }

    await expect(
      usage.consume({ userId: user.userId }, USAGE_FEATURES.DEMO, ['week']),
    ).rejects.toMatchObject({
      code: ErrorCode.USAGE_LIMIT_EXCEEDED,
      details: expect.objectContaining({ period: 'week', feature: 'demo' }),
    });
  });

  it('starts a fresh counter after the period key is removed (TTL rollover)', async () => {
    const user = await freshUser('usage-rollover');
    const usage = app.get(UsageLimitsService);

    for (let index = 0; index < DAILY; index += 1) {
      await usage.consume({ userId: user.userId }, USAGE_FEATURES.DEMO, [
        'day',
      ]);
    }

    const keys = usage.keysFor(
      { userId: user.userId },
      USAGE_FEATURES.DEMO,
      'day',
    );
    await redis.del(...keys);

    await expect(
      usage.consume({ userId: user.userId }, USAGE_FEATURES.DEMO, ['day']),
    ).resolves.toBeUndefined();
  });

  it('returns 503 when Redis cannot serve usage counters', async () => {
    const user = await freshUser('usage-down');

    await redis.quit().catch(() => undefined);
    redis.disconnect();

    const response = await request(server())
      .get('/api/v1/fixture/metered')
      .set('Cookie', user.cookie);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.code).not.toBe('USAGE_LIMIT_EXCEEDED');
  });
});
