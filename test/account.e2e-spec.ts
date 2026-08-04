import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { PermissionResolver } from '@modules/authorization/permission-resolver.service';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  grantRole,
  TEST_PASSWORD,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';

interface SessionView {
  id: string;
  current: boolean;
}

/** Integration test: requires the Compose stack, migrated and seeded. */
describe('Account endpoints (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let resolver: PermissionResolver;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    resolver = app.get(PermissionResolver);

    await clearAuthLimiterState(app.get(REDIS_CLIENT));
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  const server = () => app.getHttpServer();

  async function freshUser(label: string): Promise<TestUser> {
    const user = await createVerifiedUser({ app, prisma, mail }, label);
    createdUserIds.push(user.userId);
    return user;
  }

  /** A second, independent session for the same account. */
  async function extraSession(user: TestUser): Promise<string> {
    const signIn = await request(server())
      .post('/api/auth/sign-in/email')
      .send({ email: user.email, password: TEST_PASSWORD });

    const cookie = ((signIn.headers['set-cookie'] ?? []) as unknown as string[])
      .find((entry) => entry.includes('session_token'))
      ?.split(';')[0];

    if (!cookie) {
      throw new Error('expected a second session to be issued');
    }

    return cookie;
  }

  describe('GET /api/v1/account/me', () => {
    it('returns the principal inside the response envelope', async () => {
      const user = await freshUser('me-envelope');

      const response = await request(server())
        .get('/api/v1/account/me')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: { id: user.userId, email: user.email, emailVerified: true },
      });
      expect(response.body.meta.requestId).toBeDefined();
    });

    it('reports effective roles and permissions', async () => {
      const user = await freshUser('me-access');
      await grantRole(prisma, user.userId, 'user');
      await resolver.invalidate();

      const response = await request(server())
        .get('/api/v1/account/me')
        .set('Cookie', user.cookie);

      expect(response.body.data.roles).toContain('user');
      expect(response.body.data.permissions).toContain('account:read');
      expect(response.body.data.permissions).not.toContain('user:list');
    });

    it('requires a session', async () => {
      const response = await request(server()).get('/api/v1/account/me');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('resolves the same principal through the bearer transport', async () => {
      const user = await freshUser('me-bearer');

      const response = await request(server())
        .get('/api/v1/account/me')
        .set('Authorization', `Bearer ${user.token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(user.userId);
    });
  });

  describe('GET /api/v1/account/sessions', () => {
    it('lists the caller sessions and flags the current one', async () => {
      const user = await freshUser('sessions-list');
      await extraSession(user);

      const response = await request(server())
        .get('/api/v1/account/sessions')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(200);

      const sessions = response.body.data as SessionView[];
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions.filter((session) => session.current)).toHaveLength(1);
    });
  });

  describe('DELETE /api/v1/account/sessions/:id', () => {
    it('revokes a listed session, taking effect on its next request', async () => {
      const user = await freshUser('sessions-revoke');
      const otherCookie = await extraSession(user);

      // The other session works to begin with.
      await expect(
        request(server())
          .get('/api/v1/account/me')
          .set('Cookie', otherCookie)
          .then((r) => r.status),
      ).resolves.toBe(200);

      const listed = await request(server())
        .get('/api/v1/account/sessions')
        .set('Cookie', otherCookie);

      const target = (listed.body.data as SessionView[]).find(
        (session) => session.current,
      );
      expect(target).toBeDefined();

      // Revoke it from the first session.
      const revoked = await request(server())
        .delete(`/api/v1/account/sessions/${target?.id ?? ''}`)
        .set('Cookie', user.cookie);

      expect(revoked.status).toBe(200);

      // Immediately rejected — no cached-credential window.
      await expect(
        request(server())
          .get('/api/v1/account/me')
          .set('Cookie', otherCookie)
          .then((r) => r.status),
      ).resolves.toBe(401);

      // The revoking session is unaffected.
      await expect(
        request(server())
          .get('/api/v1/account/me')
          .set('Cookie', user.cookie)
          .then((r) => r.status),
      ).resolves.toBe(200);
    });

    it('does not confirm whether another account session id exists', async () => {
      const user = await freshUser('sessions-foreign');
      const other = await freshUser('sessions-foreign-victim');

      const victimSessions = await request(server())
        .get('/api/v1/account/sessions')
        .set('Cookie', other.cookie);

      const victimSessionId = (victimSessions.body.data as SessionView[])[0].id;

      const attempt = await request(server())
        .delete(`/api/v1/account/sessions/${victimSessionId}`)
        .set('Cookie', user.cookie);

      // Same answer as revoking one's own, so the id is not an oracle…
      expect(attempt.status).toBe(200);

      // …and the victim's session still works.
      await expect(
        request(server())
          .get('/api/v1/account/me')
          .set('Cookie', other.cookie)
          .then((r) => r.status),
      ).resolves.toBe(200);
    });
  });

  describe('POST /api/v1/account/sessions/revoke-others', () => {
    it('leaves only the current session working', async () => {
      const user = await freshUser('sessions-revoke-others');
      const second = await extraSession(user);
      const third = await extraSession(user);

      const response = await request(server())
        .post('/api/v1/account/sessions/revoke-others')
        .set('Cookie', user.cookie);

      expect(response.status).toBe(201);

      // If the endpoint rotated the current cookie, follow it — otherwise the
      // assertion below would fail for the wrong reason.
      const rotated = (
        (response.headers['set-cookie'] ?? []) as unknown as string[]
      )
        .find((entry) => entry.includes('session_token'))
        ?.split(';')[0];
      const currentCookie = rotated ?? user.cookie;

      for (const revoked of [second, third]) {
        await expect(
          request(server())
            .get('/api/v1/account/me')
            .set('Cookie', revoked)
            .then((r) => r.status),
        ).resolves.toBe(401);
      }

      await expect(
        request(server())
          .get('/api/v1/account/me')
          .set('Cookie', currentCookie)
          .then((r) => r.status),
      ).resolves.toBe(200);
    });
  });

  describe('sign-out', () => {
    it('stops the token authenticating immediately afterwards', async () => {
      const user = await freshUser('signout');

      await request(server())
        .post('/api/auth/sign-out')
        .set('Cookie', user.cookie);

      await expect(
        request(server())
          .get('/api/v1/account/me')
          .set('Cookie', user.cookie)
          .then((r) => r.status),
      ).resolves.toBe(401);
    });

    it('revokes both transports of the same session together', async () => {
      const user = await freshUser('signout-bearer');

      await request(server())
        .post('/api/auth/sign-out')
        .set('Cookie', user.cookie);

      // The bearer token is the same session token, so it must be gone too.
      await expect(
        request(server())
          .get('/api/v1/account/me')
          .set('Authorization', `Bearer ${user.token}`)
          .then((r) => r.status),
      ).resolves.toBe(401);
    });
  });
});
