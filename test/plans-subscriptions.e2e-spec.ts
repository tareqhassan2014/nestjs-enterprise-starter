import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { PLAN_SLUGS } from '@modules/plans/entitlements';
import { ENTITLEMENTS } from '@modules/plans/entitlements';
import { PlanResolutionService } from '@modules/plans/plan-resolution.service';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';
import { PlansFixtureModule } from './fixtures/plans-fixture.module';

describe('Plans and subscriptions (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    del: (...keys: string[]) => Promise<number>;
  };
  let plans: PlanResolutionService;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp(undefined, [PlansFixtureModule]);
    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    redis = app.get(REDIS_CLIENT);
    plans = app.get(PlanResolutionService);

    await clearAuthLimiterState(redis);
    await plans.reloadMatrices();
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

  async function assignPlan(
    userId: string,
    slug: string,
    status: 'active' | 'past_due' | 'canceled',
    currentPeriodEnd?: Date | null,
  ): Promise<void> {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { slug } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.subscription.create({
      data: {
        userId,
        planId: plan.id,
        interval: 'monthly',
        status,
        currentPeriodStart: new Date(),
        currentPeriodEnd: currentPeriodEnd ?? null,
        canceledAt: status === 'canceled' ? new Date() : null,
      },
    });
  }

  describe('GET /api/v1/billing/plan', () => {
    it('returns 401 without a session', async () => {
      const response = await request(server()).get('/api/v1/billing/plan');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns Lite fallback for a user with no subscription', async () => {
      const user = await freshUser('plan-lite-fallback');

      const response = await request(server())
        .get('/api/v1/billing/plan')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.plan.slug).toBe(PLAN_SLUGS.LITE);
      expect(response.body.data.fromSubscription).toBe(false);
      expect(response.body.data.subscription).toBeNull();
      expect(response.body.data.entitlements[ENTITLEMENTS.FEATURE_ADVANCED]).toBe(
        false,
      );
      expect(response.body.data.limits.demo.daily).toBe(100);
    });

    it('returns Pro when an active Pro subscription exists', async () => {
      const user = await freshUser('plan-pro-active');
      await assignPlan(user.userId, PLAN_SLUGS.PRO, 'active');

      const response = await request(server())
        .get('/api/v1/billing/plan')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(200);
      expect(response.body.data.plan.slug).toBe(PLAN_SLUGS.PRO);
      expect(response.body.data.fromSubscription).toBe(true);
      expect(response.body.data.subscription.status).toBe('active');
      expect(response.body.data.entitlements[ENTITLEMENTS.FEATURE_ADVANCED]).toBe(
        true,
      );
      expect(response.body.data.limits.demo.daily).toBe(1_000);
    });
  });

  describe('entitlement gate', () => {
    it('denies Lite on @RequireEntitlement(feature.advanced)', async () => {
      const user = await freshUser('entitlement-lite');

      const response = await request(server())
        .get('/api/v1/fixture/advanced')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ENTITLEMENT_DENIED');
    });

    it('allows Pro on @RequireEntitlement(feature.advanced)', async () => {
      const user = await freshUser('entitlement-pro');
      await assignPlan(user.userId, PLAN_SLUGS.PRO, 'active');

      const response = await request(server())
        .get('/api/v1/fixture/advanced')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(200);
      expect(response.body.data.ok).toBe(true);
    });

    it('does not burn usage counters when entitlement is denied', async () => {
      const user = await freshUser('entitlement-no-burn');

      const denied = await request(server())
        .get('/api/v1/fixture/advanced-metered')
        .set('Cookie', user.cookie);

      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('ENTITLEMENT_DENIED');

      const keys = await redis.keys(`usage:*:u:${user.userId}`);
      expect(keys).toHaveLength(0);
    });
  });

  describe('subscription lifecycle', () => {
    it('allows past_due Pro through the entitlement gate', async () => {
      const user = await freshUser('lifecycle-past-due');
      await assignPlan(user.userId, PLAN_SLUGS.PRO, 'past_due');

      const response = await request(server())
        .get('/api/v1/fixture/advanced')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(200);
    });

    it('falls back to Lite after canceled period end', async () => {
      const user = await freshUser('lifecycle-canceled');
      await assignPlan(
        user.userId,
        PLAN_SLUGS.PRO,
        'canceled',
        new Date('2020-01-01T00:00:00Z'),
      );

      const plan = await request(server())
        .get('/api/v1/billing/plan')
        .set('Cookie', user.cookie);

      expect(plan.body.data.plan.slug).toBe(PLAN_SLUGS.LITE);

      const gated = await request(server())
        .get('/api/v1/fixture/advanced')
        .set('Cookie', user.cookie);

      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe('ENTITLEMENT_DENIED');
    });
  });

  describe('plan-aware usage ceilings', () => {
    it('enforces different demo ceilings for Lite vs Pro', async () => {
      const liteUser = await freshUser('usage-lite-ceiling');
      const proUser = await freshUser('usage-pro-ceiling');
      await assignPlan(proUser.userId, PLAN_SLUGS.PRO, 'active');

      const lite = await plans.resolve(liteUser.userId);
      const pro = await plans.resolve(proUser.userId);

      expect(lite.usageLimits.demo.daily).toBe(100);
      expect(pro.usageLimits.demo.daily).toBe(1_000);
      expect(pro.usageLimits.demo.daily).toBeGreaterThan(
        lite.usageLimits.demo.daily,
      );
    });
  });
});
