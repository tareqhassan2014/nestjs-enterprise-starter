import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { CreditService } from '@modules/credits/credit.service';
import { organizationSubject } from '@modules/organizations/billing-subject';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';

describe('Organizations + billing subject (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let credits: CreditService;
  let owner: TestUser;
  let outsider: TestUser;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    credits = app.get(CreditService);
    await clearAuthLimiterState(app.get(REDIS_CLIENT));

    owner = await createVerifiedUser({ app, prisma, mail }, 'org-owner');
    outsider = await createVerifiedUser({ app, prisma, mail }, 'org-outsider');
    createdUserIds.push(owner.userId, outsider.userId);
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.organizationMember.deleteMany({
          where: { userId: { in: createdUserIds } },
        });
        await prisma.creditLedgerEntry.deleteMany({
          where: { organizationId: { not: null } },
        });
        await prisma.creditWallet.deleteMany({
          where: { organizationId: { not: null } },
        });
        await prisma.organization.deleteMany({
          where: { members: { none: {} } },
        });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
    } catch {
      // Best-effort cleanup when schema/migration is mid-flight.
    }
    await app?.close();
  });

  it('creates an organization and lists it for the owner', async () => {
    const slug = `acme-${Date.now()}`;
    const create = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Cookie', owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Acme Corp', slug });

    if (create.status !== 201) {
      throw new Error(
        `create org failed (${create.status}): ${JSON.stringify(create.body)}`,
      );
    }

    expect(create.body.success).toBe(true);
    expect(create.body.data.slug).toBe(slug);

    const list = await request(app.getHttpServer())
      .get('/api/v1/organizations')
      .set('Cookie', owner.cookie)
      .expect(200);

    expect(
      list.body.data.some(
        (row: { organization: { slug: string } }) =>
          row.organization.slug === slug,
      ),
    ).toBe(true);
  });

  it('rejects org create without Idempotency-Key', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Cookie', owner.cookie)
      .send({ name: 'No Key', slug: `nokey-${Date.now()}` })
      .expect(400);

    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('forbids binding an organization the caller does not belong to', async () => {
    const slug = `deny-${Date.now()}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Cookie', owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Private Org', slug })
      .expect(201);

    const organizationId = created.body.data.id as string;

    const response = await request(app.getHttpServer())
      .get('/api/v1/billing/credits')
      .set('Cookie', outsider.cookie)
      .set('X-Organization-Id', organizationId)
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('resolves org-primary billing subject for members', async () => {
    const slug = `bill-${Date.now()}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Cookie', owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Billing Org', slug })
      .expect(201);

    const organizationId = created.body.data.id as string;

    await prisma.organization.update({
      where: { id: organizationId },
      data: { billingMode: 'organization' },
    });

    await credits.grant({
      subject: organizationSubject(organizationId),
      amount: 42,
      idempotencyKey: `e2e-org-grant-${organizationId}`,
    });

    const withoutOrg = await request(app.getHttpServer())
      .get('/api/v1/billing/credits')
      .set('Cookie', owner.cookie)
      .expect(200);

    expect(withoutOrg.body.data.subject).toBe('user');

    const withOrg = await request(app.getHttpServer())
      .get('/api/v1/billing/credits')
      .set('Cookie', owner.cookie)
      .set('X-Organization-Id', organizationId)
      .expect(200);

    expect(withOrg.body.data.subject).toBe('organization');
    expect(withOrg.body.data.balance).toBe(42);
  });
});
