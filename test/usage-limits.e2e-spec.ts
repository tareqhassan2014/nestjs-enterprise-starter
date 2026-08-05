import { randomUUID } from 'node:crypto';

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
import { PLAN_SLUGS } from '@modules/plans/entitlements';
import { PlanResolutionService } from '@modules/plans/plan-resolution.service';
import type { EffectivePlan } from '@modules/plans/plan-resolution.service';
import {
  usageSubject,
  UsageLimitsService,
} from '@modules/usage-limits/usage-limits.service';
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

/** Stub plan resolution so this suite does not mutate shared seed matrices. */
const tightPlan: EffectivePlan = {
  planId: 'test-lite',
  slug: PLAN_SLUGS.LITE,
  name: 'Lite',
  rank: 10,
  fromSubscription: false,
  subscriptionId: null,
  status: null,
  interval: null,
  currentPeriodEnd: null,
  entitlements: {},
  usageLimits: {
    demo: { daily: DAILY, weekly: WEEKLY },
  },
};

/**
 * Ceilings for an organization, deliberately **tighter** than the member's.
 *
 * Inverted on purpose. If the org were the more generous of the two, the member's
 * ceiling would always bind first and the assertion could not tell whose plan
 * produced the org counter's limit. Making the org the binding constraint is what
 * distinguishes "resolved from the organization's plan" from the old behaviour,
 * which compared the org count to the *caller's* ceiling.
 */
const ORG_DAILY = 2;
const ORG_WEEKLY = 4;

const orgPlan: EffectivePlan = {
  ...tightPlan,
  planId: 'test-org',
  usageLimits: {
    demo: { daily: ORG_DAILY, weekly: ORG_WEEKLY },
  },
};

/**
 * Subject-aware, so a user scope and an organization scope resolve different
 * ceilings. The previous stub returned one plan for any subject, which could not
 * express the distinction this change is about.
 */
const tightPlans: Pick<
  PlanResolutionService,
  'resolve' | 'usageCeiling' | 'reloadMatrices' | 'onModuleInit'
> = {
  onModuleInit: () => Promise.resolve(),
  reloadMatrices: () => Promise.resolve(),
  resolve: (subject) =>
    Promise.resolve(
      typeof subject !== 'string' && subject.type === 'organization'
        ? orgPlan
        : tightPlan,
    ),
  // Reads the plan it was handed rather than closing over constants, so the
  // org/member distinction survives into the ceiling.
  usageCeiling: (plan, feature, period) => {
    const row = plan.usageLimits[feature];
    if (!row) {
      return undefined;
    }

    return period === 'day' ? row.daily : row.weekly;
  },
};

describe('Usage limits (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    get: (key: string) => Promise<string | null>;
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
          .overrideProvider(PlanResolutionService)
          .useValue(tightPlans)
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
      await usage.consume(usageSubject(user.userId), USAGE_FEATURES.DEMO, [
        'week',
      ]);
    }

    await expect(
      usage.consume(usageSubject(user.userId), USAGE_FEATURES.DEMO, ['week']),
    ).rejects.toMatchObject({
      code: ErrorCode.USAGE_LIMIT_EXCEEDED,
      details: expect.objectContaining({ period: 'week', feature: 'demo' }),
    });
  });

  it('starts a fresh counter after the period key is removed (TTL rollover)', async () => {
    const user = await freshUser('usage-rollover');
    const usage = app.get(UsageLimitsService);

    for (let index = 0; index < DAILY; index += 1) {
      await usage.consume(usageSubject(user.userId), USAGE_FEATURES.DEMO, [
        'day',
      ]);
    }

    const keys = usage.keysFor(
      usageSubject(user.userId),
      USAGE_FEATURES.DEMO,
      'day',
    );
    await redis.del(...keys);

    await expect(
      usage.consume(usageSubject(user.userId), USAGE_FEATURES.DEMO, ['day']),
    ).resolves.toBeUndefined();
  });

  describe('organization scope', () => {
    /** An org that bills itself, with the caller as a member. */
    async function orgBoundUser(label: string) {
      const user = await freshUser(label);

      const created = await request(server())
        .post('/api/v1/organizations')
        .set('Cookie', user.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'Usage Org', slug: `usage-${label}-${Date.now()}` })
        .expect(201);

      const organizationId = created.body.data.id as string;

      await prisma.organization.update({
        where: { id: organizationId },
        data: { billingMode: 'organization' },
      });

      return { user, organizationId };
    }

    it("measures the organization counter against the organization's own plan", async () => {
      const { user, organizationId } = await orgBoundUser('org-ceiling');
      const usage = app.get(UsageLimitsService);

      const subject = {
        actorUserId: user.userId,
        billing: { type: 'organization' as const, organizationId },
      };

      // The org ceiling (2) is tighter than the member's (3), so it binds first.
      for (let index = 0; index < ORG_DAILY; index += 1) {
        await usage.consume(subject, USAGE_FEATURES.DEMO, ['day']);
      }

      /**
       * Rejected at the organization's ceiling while the member still has room.
       * Previously `check` took `Math.max` of the two counts and compared it to the
       * *caller's* ceiling, so this consume was admitted and an org limit could
       * never be tighter than a member's however the matrices were configured.
       */
      await expect(
        usage.consume(subject, USAGE_FEATURES.DEMO, ['day']),
      ).rejects.toMatchObject({
        code: ErrorCode.USAGE_LIMIT_EXCEEDED,
      });
    });

    it('enforces the organization counter for a guard-metered request', async () => {
      const { user, organizationId } = await orgBoundUser('org-guard');

      const statuses: number[] = [];
      for (let index = 0; index < ORG_DAILY + 1; index += 1) {
        statuses.push(
          (
            await request(server())
              .get('/api/v1/fixture/metered')
              .set('Cookie', user.cookie)
              .set('X-Organization-Id', organizationId)
          ).status,
        );
      }

      /**
       * The guard passed a member-only subject before this change, so no HTTP route
       * ever enforced an org ceiling — the caller would have got `ORG_DAILY + 1`
       * successes here, stopped only by their own (looser) member ceiling.
       */
      expect(statuses.filter((status) => status === 200).length).toBe(
        ORG_DAILY,
      );
      expect(statuses).toContain(429);

      /**
       * And the org counter physically exists, which is the part that could not
       * have happened before: the guard now resolves the organization through
       * `BillingSubjectResolver`, so the `o:` key is written from the HTTP path
       * rather than only ever from a direct service call.
       */
      const orgKeys = await redis.keys(`usage:day:*:o:${organizationId}`);
      expect(orgKeys.length).toBeGreaterThan(0);
    });

    it("rejects on the member's own ceiling even when the organization has room", async () => {
      const { user, organizationId } = await orgBoundUser('org-member-binds');
      const usage = app.get(UsageLimitsService);

      /**
       * Exhausts the member's counter *without* touching the organization's, by
       * consuming as a member-only subject first. Necessary because this suite's
       * org plan is deliberately the tighter of the two — so left to itself the org
       * always binds first, and the member's ceiling would never be the thing under
       * test.
       */
      for (let index = 0; index < DAILY; index += 1) {
        await usage.consume(usageSubject(user.userId), USAGE_FEATURES.DEMO, [
          'day',
        ]);
      }

      /**
       * The organization counter is still at zero against its own ceiling, so the
       * only thing that can refuse this is the member's. That is the property: an
       * org plan raises the *aggregate* allowance, it does not exempt a member from
       * their own.
       */
      await expect(
        usage.consume(
          {
            actorUserId: user.userId,
            billing: { type: 'organization' as const, organizationId },
          },
          USAGE_FEATURES.DEMO,
          ['day'],
        ),
      ).rejects.toMatchObject({ code: ErrorCode.USAGE_LIMIT_EXCEEDED });
    });

    it('leaves the member counter untouched when the organization ceiling rejects', async () => {
      const { user, organizationId } = await orgBoundUser('org-no-charge');
      const usage = app.get(UsageLimitsService);

      const subject = {
        actorUserId: user.userId,
        billing: { type: 'organization' as const, organizationId },
      };

      for (let index = 0; index < ORG_DAILY; index += 1) {
        await usage.consume(subject, USAGE_FEATURES.DEMO, ['day']);
      }

      const [memberKey] = usage.keysFor(subject, USAGE_FEATURES.DEMO, 'day');
      const before = await redis.get(memberKey);

      await expect(
        usage.consume(subject, USAGE_FEATURES.DEMO, ['day']),
      ).rejects.toMatchObject({ code: ErrorCode.USAGE_LIMIT_EXCEEDED });

      /**
       * Unchanged, so a denied request does not spend the member's own allowance.
       * Holds here via the pre-check, which rejects before touching a counter; the
       * harder path — a ceiling crossed *during* the increment loop, where earlier
       * increments must be rolled back — is covered in `usage-limits.service.spec.ts`
       * because forcing that race deterministically over HTTP is not practical.
       */
      expect(await redis.get(memberKey)).toBe(before);
    });
  });

  it('leaves the daily counter untouched when the weekly ceiling rejects', async () => {
    const user = await freshUser('usage-weekly-no-charge');
    const usage = app.get(UsageLimitsService);
    const subject = usageSubject(user.userId);

    // Exhaust the weekly ceiling using week-only consumes, so the daily counter
    // stays well under its own limit.
    for (let index = 0; index < WEEKLY; index += 1) {
      await usage.consume(subject, USAGE_FEATURES.DEMO, ['week']);
    }

    const [dayKey] = usage.keysFor(subject, USAGE_FEATURES.DEMO, 'day');
    const before = await redis.get(dayKey);

    await expect(
      usage.consume(subject, USAGE_FEATURES.DEMO, ['day', 'week']),
    ).rejects.toMatchObject({ code: ErrorCode.USAGE_LIMIT_EXCEEDED });

    expect(await redis.get(dayKey)).toBe(before);
  });

  it('returns 503 when a ceiling cannot be resolved, not a quota error', async () => {
    const user = await freshUser('usage-plan-down');
    const usage = app.get(UsageLimitsService);
    const plans = app.get(PlanResolutionService);

    const spy = jest
      .spyOn(plans, 'resolve')
      .mockRejectedValue(new Error('subscriptions unreadable'));

    try {
      /**
       * Ceiling resolution reads persisted subscriptions. It used to sit *outside*
       * the fail-closed boundary, so a database failure there escaped as
       * `500 INTERNAL_ERROR` while an identical-looking counter-store failure gave
       * `503` — the same remedy reported two different ways.
       */
      await expect(
        usage.consume(usageSubject(user.userId), USAGE_FEATURES.DEMO, ['day']),
      ).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
    } finally {
      spy.mockRestore();
    }
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
