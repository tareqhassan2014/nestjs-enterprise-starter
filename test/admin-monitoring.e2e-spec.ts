import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { observabilityConfig } from '@config/observability.config';
import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { CreditService } from '@modules/credits/credit.service';
import { PermissionResolver } from '@modules/authorization/permission-resolver.service';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  grantRole,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';

describe('Admin monitoring (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let credits: CreditService;
  let resolver: PermissionResolver;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    del: (...keys: string[]) => Promise<number>;
  };
  const createdUserIds: string[] = [];

  let admin: TestUser;
  let member: TestUser;
  let target: TestUser;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(observabilityConfig.KEY).useValue({
        metricsEnabled: true,
        metricsBearerToken: 'metrics-secret',
        swaggerEnabled: false,
        adminUsageTopN: 20,
      }),
    );

    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    credits = app.get(CreditService);
    resolver = app.get(PermissionResolver);
    redis = app.get(REDIS_CLIENT);

    await clearAuthLimiterState(redis);

    admin = await createVerifiedUser({ app, prisma, mail }, 'admin-mon');
    member = await createVerifiedUser({ app, prisma, mail }, 'member-mon');
    target = await createVerifiedUser({ app, prisma, mail }, 'target-mon');
    createdUserIds.push(admin.userId, member.userId, target.userId);

    await grantRole(prisma, admin.userId, 'admin');
    await resolver.invalidate();
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  describe('RBAC', () => {
    it('rejects non-admin on admin usage pressure', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/usage/pressure')
        .set('Cookie', member.cookie);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('allows admin metrics read', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/usage/pressure')
        .set('Cookie', admin.cookie);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(
        expect.objectContaining({
          httpRequestsTotal: expect.any(Number),
        }),
      );
    });
  });

  describe('billing inspect/adjust', () => {
    it('returns 404 for unknown user subscription', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/users/does-not-exist/subscription')
        .set('Cookie', admin.cookie);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects adjust without reason', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.userId}/credits/adjust`)
        .set('Cookie', admin.cookie)
        .send({ delta: 5, idempotencyKey: 'adj-no-reason' });

      expect(response.status).toBe(400);
    });

    it('grants credits, writes audit, and reflects on self-balance', async () => {
      const key = `admin-grant-${Date.now()}`;
      const grant = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.userId}/credits/grant`)
        .set('Cookie', admin.cookie)
        .send({
          amount: 25,
          idempotencyKey: key,
          reason: 'e2e top-up',
        });

      expect(grant.status).toBe(200);
      expect(grant.body.data.balance).toBe(25);

      const replay = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.userId}/credits/grant`)
        .set('Cookie', admin.cookie)
        .send({
          amount: 25,
          idempotencyKey: key,
          reason: 'e2e top-up',
        });
      expect(replay.body.data.replayed).toBe(true);
      expect(replay.body.data.balance).toBe(25);

      const balance = await credits.getBalance(target.userId);
      expect(balance).toBe(25);

      const self = await request(app.getHttpServer())
        .get('/api/v1/billing/credits')
        .set('Cookie', target.cookie);
      expect(self.body.data.balance).toBe(25);

      const audit = await request(app.getHttpServer())
        .get('/api/v1/admin/audit')
        .query({ action: 'credits.grant', targetId: target.userId })
        .set('Cookie', admin.cookie);

      expect(audit.status).toBe(200);
      expect(audit.body.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it('denies credits:read holder from adjust', async () => {
      // member has no admin perms
      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.userId}/credits/adjust`)
        .set('Cookie', member.cookie)
        .send({
          delta: 1,
          idempotencyKey: 'nope',
          reason: 'should fail',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('metrics scrape', () => {
    it('requires bearer when configured', async () => {
      const denied = await request(app.getHttpServer()).get('/metrics');
      expect(denied.status).toBe(401);

      const ok = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', 'Bearer metrics-secret');

      expect(ok.status).toBe(200);
      expect(ok.text).toContain('http_requests_total');
      expect(ok.headers['content-type']).toMatch(/text\/plain/);
    });
  });

  describe('usage snapshots', () => {
    it('returns catalogue snapshots for a user', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/usage/users/${target.userId}`)
        .set('Cookie', admin.cookie);

      expect(response.status).toBe(200);
      expect(response.body.data.snapshots.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects unknown feature', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/usage/users/${target.userId}`)
        .query({ feature: 'not-a-feature' })
        .set('Cookie', admin.cookie);

      expect(response.status).toBe(400);
    });
  });
});
