import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { stripeConfig } from '@config/stripe.config';
import { redisConfig } from '@config/redis.config';
import { usageLimitsConfig } from '@config/usage-limits.config';
import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { STRIPE_CLIENT } from '@modules/billing/stripe.tokens';
import { CreditService } from '@modules/credits/credit.service';
import { PLAN_SLUGS } from '@modules/plans/entitlements';
import {
  type EffectivePlan,
  PlanResolutionService,
} from '@modules/plans/plan-resolution.service';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';
import { CreditsFixtureModule } from './fixtures/credits-fixture.module';

const DAILY = 2;
const WEEKLY = 10;

const tightPlan: EffectivePlan = {
  planId: 'test-lite-credits',
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

const tightPlans: Pick<
  PlanResolutionService,
  | 'resolve'
  | 'usageCeiling'
  | 'reloadMatrices'
  | 'onModuleInit'
  | 'hasEntitlement'
  | 'meetsMinimumPlan'
> = {
  onModuleInit: () => Promise.resolve(),
  reloadMatrices: () => Promise.resolve(),
  resolve: () => Promise.resolve(tightPlan),
  usageCeiling: (_plan, _feature, period) =>
    period === 'day' ? DAILY : WEEKLY,
  hasEntitlement: (plan, key) => plan.entitlements[key] === true,
  meetsMinimumPlan: (plan, slug) => {
    const ranks: Record<string, number> = {
      [PLAN_SLUGS.LITE]: 10,
      [PLAN_SLUGS.PRO]: 20,
      [PLAN_SLUGS.ENTERPRISE]: 30,
    };
    return plan.rank >= (ranks[slug] ?? Number.MAX_SAFE_INTEGER);
  },
};

const stripeEnabled = {
  enabled: true as const,
  secretKey: 'sk_test_e2e',
  webhookSecret: 'whsec_e2e',
  packs: [{ slug: 'starter', credits: 100, priceId: 'price_starter' }],
  packsBySlug: {
    starter: { slug: 'starter', credits: 100, priceId: 'price_starter' },
  },
  successUrl: 'http://localhost:3000/billing/success',
  cancelUrl: 'http://localhost:3000/billing/cancel',
  apiVersion: '2026-07-29.dahlia' as const,
  lowBalanceThreshold: undefined,
};

describe('Credits and Stripe top-up (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let credits: CreditService;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    del: (...keys: string[]) => Promise<number>;
  };
  const createdUserIds: string[] = [];
  const mockCheckoutCreate = jest.fn().mockResolvedValue({
    id: 'cs_test',
    url: 'https://checkout.stripe.test/session',
  });
  const mockConstructEvent = jest.fn();

  beforeAll(async () => {
    app = await createTestApp(
      (builder) =>
        builder
          .overrideProvider(usageLimitsConfig.KEY)
          .useValue({
            default: { daily: DAILY, weekly: WEEKLY },
            features: { demo: { daily: DAILY, weekly: WEEKLY } },
          })
          .overrideProvider(PlanResolutionService)
          .useValue(tightPlans)
          .overrideProvider(stripeConfig.KEY)
          .useValue(stripeEnabled)
          .overrideProvider(STRIPE_CLIENT)
          .useValue({
            customers: {
              create: jest.fn().mockResolvedValue({ id: 'cus_test' }),
            },
            checkout: {
              sessions: { create: mockCheckoutCreate },
            },
            webhooks: {
              constructEvent: mockConstructEvent,
            },
          })
          // Isolate usage counters from other e2e suites (usage-limits uses /11).
          .overrideProvider(redisConfig.KEY)
          .useValue({ ...redisConfig(), url: `${redisConfig().url}/12` }),
      [CreditsFixtureModule],
    );
    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    credits = app.get(CreditService);
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

  beforeEach(async () => {
    await clearUsageKeys();
    mockCheckoutCreate.mockClear();
    mockConstructEvent.mockReset();
  });

  const server = () => app.getHttpServer();

  async function freshUser(label: string): Promise<TestUser> {
    const user = await createVerifiedUser({ app, prisma, mail }, label);
    createdUserIds.push(user.userId);
    return user;
  }

  describe('GET /api/v1/billing/credits', () => {
    it('returns 401 without a session', async () => {
      const response = await request(server()).get('/api/v1/billing/credits');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns zero balance for a new user', async () => {
      const user = await freshUser('credits-balance-zero');
      const response = await request(server())
        .get('/api/v1/billing/credits')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.balance).toBe(0);
    });
  });

  describe('POST /api/v1/billing/demo/paid', () => {
    it('returns 402 INSUFFICIENT_CREDITS when balance is zero', async () => {
      const user = await freshUser('credits-insufficient');
      const response = await request(server())
        .post('/api/v1/billing/demo/paid')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(402);
      expect(response.body.error.code).toBe('INSUFFICIENT_CREDITS');
      expect(await credits.getBalance(user.userId)).toBe(0);
    });

    it('debits on success', async () => {
      const user = await freshUser('credits-spend-ok');
      await credits.grant({
        userId: user.userId,
        amount: 5,
        idempotencyKey: `test-grant-${user.userId}`,
      });

      const response = await request(server())
        .post('/api/v1/billing/demo/paid')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.ok).toBe(true);
      expect(await credits.getBalance(user.userId)).toBe(4);
    });
  });

  describe('guard order', () => {
    it('does not debit when usage limit denies first', async () => {
      const user = await freshUser('credits-usage-first');
      await credits.grant({
        userId: user.userId,
        amount: 10,
        idempotencyKey: `test-grant-usage-${user.userId}`,
      });

      for (let i = 0; i < DAILY; i++) {
        const ok = await request(server())
          .post('/api/v1/fixture/usage-and-credits')
          .set('Cookie', user.cookie);
        expect(ok.status).toBe(201);
      }

      const before = await credits.getBalance(user.userId);
      const denied = await request(server())
        .post('/api/v1/fixture/usage-and-credits')
        .set('Cookie', user.cookie);

      expect(denied.status).toBe(429);
      expect(denied.body.error.code).toBe('USAGE_LIMIT_EXCEEDED');
      expect(await credits.getBalance(user.userId)).toBe(before);
    });

    it('does not debit when entitlement denies first', async () => {
      const user = await freshUser('credits-entitlement-first');
      await credits.grant({
        userId: user.userId,
        amount: 10,
        idempotencyKey: `test-grant-ent-${user.userId}`,
      });

      const before = await credits.getBalance(user.userId);
      const denied = await request(server())
        .post('/api/v1/fixture/entitlement-and-credits')
        .set('Cookie', user.cookie);

      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('ENTITLEMENT_DENIED');
      expect(await credits.getBalance(user.userId)).toBe(before);
    });
  });

  describe('Stripe checkout and webhook', () => {
    it('creates a checkout session for a known pack', async () => {
      const user = await freshUser('credits-checkout');
      const response = await request(server())
        .post('/api/v1/billing/checkout')
        .set('Cookie', user.cookie)
        .set('Idempotency-Key', `checkout-${user.userId}-starter`)
        .send({ pack: 'starter' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.checkoutUrl).toContain('checkout.stripe.test');
      expect(mockCheckoutCreate).toHaveBeenCalled();
    });

    it('rejects unknown packs', async () => {
      const user = await freshUser('credits-unknown-pack');
      const response = await request(server())
        .post('/api/v1/billing/checkout')
        .set('Cookie', user.cookie)
        .set('Idempotency-Key', `checkout-${user.userId}-nope`)
        .send({ pack: 'nope' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('BAD_REQUEST');
    });

    it('grants credits from a signed webhook once', async () => {
      const user = await freshUser('credits-webhook');
      const sessionId = `cs_${user.userId}`;

      mockConstructEvent.mockImplementation(() => ({
        id: `evt_${user.userId}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: sessionId,
            payment_status: 'paid',
            status: 'complete',
            metadata: {
              userId: user.userId,
              creditPack: 'starter',
              credits: '999',
            },
            client_reference_id: user.userId,
          },
        },
      }));

      const body = Buffer.from(JSON.stringify({ ping: true }));

      const first = await request(server())
        .post('/api/v1/billing/webhook')
        .set('stripe-signature', 't=1,v1=test')
        .set('Content-Type', 'application/json')
        .send(body);

      expect(first.status).toBe(200);
      expect(first.body).toEqual({ received: true });
      expect(first.body.success).toBeUndefined();
      expect(await credits.getBalance(user.userId)).toBe(100);

      const second = await request(server())
        .post('/api/v1/billing/webhook')
        .set('stripe-signature', 't=1,v1=test')
        .set('Content-Type', 'application/json')
        .send(body);

      expect(second.status).toBe(200);
      expect(await credits.getBalance(user.userId)).toBe(100);
    });

    /**
     * Settlement, which the original guard could not enforce.
     *
     * `payment_status !== 'paid' && status !== 'complete'` was unreachable for
     * these events — `status` is `'complete'` by definition, so the `&&`
     * short-circuited and every completed session was credited regardless of
     * payment. The suite's only webhook case passed `payment_status: 'paid'`, so
     * the hole was invisible.
     */
    describe('settlement', () => {
      /** Builds a signed-event stub for one session payload. */
      function stubEvent(
        eventId: string,
        type: string,
        session: Record<string, unknown>,
      ) {
        mockConstructEvent.mockImplementation(() => ({
          id: eventId,
          type,
          data: { object: session },
        }));
      }

      const post = () =>
        request(server())
          .post('/api/v1/billing/webhook')
          .set('stripe-signature', 't=1,v1=test')
          .set('Content-Type', 'application/json')
          .send(Buffer.from(JSON.stringify({ ping: true })));

      const sessionFor = (
        user: TestUser,
        paymentStatus: string,
        id: string,
      ) => ({
        id,
        payment_status: paymentStatus,
        status: 'complete',
        metadata: { userId: user.userId, creditPack: 'starter' },
        client_reference_id: user.userId,
      });

      it('grants nothing for a completed but unpaid session', async () => {
        const user = await freshUser('credits-unpaid');
        stubEvent(
          `evt_unpaid_${user.userId}`,
          'checkout.session.completed',
          sessionFor(user, 'unpaid', `cs_unpaid_${user.userId}`),
        );

        const response = await post();

        // Acknowledged — this is a legitimate state, not a delivery failure.
        expect(response.status).toBe(200);
        expect(await credits.getBalance(user.userId)).toBe(0);
      });

      it('grants when the session required no payment', async () => {
        const user = await freshUser('credits-nopay');
        stubEvent(
          `evt_nopay_${user.userId}`,
          'checkout.session.completed',
          sessionFor(user, 'no_payment_required', `cs_nopay_${user.userId}`),
        );

        expect((await post()).status).toBe(200);

        // A fully discounted pack settles nothing and must still deliver.
        expect(await credits.getBalance(user.userId)).toBe(100);
      });

      it('grants when a delayed payment later succeeds', async () => {
        const user = await freshUser('credits-async');
        const sessionId = `cs_async_${user.userId}`;

        // Completes unpaid: nothing granted yet.
        stubEvent(
          `evt_c_${user.userId}`,
          'checkout.session.completed',
          sessionFor(user, 'unpaid', sessionId),
        );
        expect((await post()).status).toBe(200);
        expect(await credits.getBalance(user.userId)).toBe(0);

        /**
         * Settles later. Without this event type being routed, the customer would
         * have paid and never been credited — which is why the settlement fix and
         * this handler had to land together.
         */
        stubEvent(
          `evt_a_${user.userId}`,
          'checkout.session.async_payment_succeeded',
          sessionFor(user, 'paid', sessionId),
        );
        expect((await post()).status).toBe(200);
        expect(await credits.getBalance(user.userId)).toBe(100);
      });

      it('credits once in total when completion and settlement both arrive paid', async () => {
        const user = await freshUser('credits-both');
        const sessionId = `cs_both_${user.userId}`;

        stubEvent(
          `evt_bc_${user.userId}`,
          'checkout.session.completed',
          sessionFor(user, 'paid', sessionId),
        );
        expect((await post()).status).toBe(200);

        stubEvent(
          `evt_ba_${user.userId}`,
          'checkout.session.async_payment_succeeded',
          sessionFor(user, 'paid', sessionId),
        );
        expect((await post()).status).toBe(200);

        /**
         * Two distinct events, two processed-event rows, one grant — the canonical
         * `stripe:checkout:{id}` key is what converges them, not the processed-event
         * table.
         */
        expect(await credits.getBalance(user.userId)).toBe(100);
      });
    });

    it('rejects invalid webhook signatures', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('bad sig');
      });

      const response = await request(server())
        .post('/api/v1/billing/webhook')
        .set('stripe-signature', 'bad')
        .set('Content-Type', 'application/json')
        .send(Buffer.from('{}'));

      expect(response.status).toBe(400);
    });

    it('top-up then demo spend succeeds', async () => {
      const user = await freshUser('credits-topup-spend');
      await credits.grant({
        userId: user.userId,
        amount: 1,
        idempotencyKey: `stripe:checkout:cs_manual_${user.userId}`,
        metadata: { source: 'test_sim_topup' },
      });

      const response = await request(server())
        .post('/api/v1/billing/demo/paid')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(201);
      expect(await credits.getBalance(user.userId)).toBe(0);
    });
  });
});
