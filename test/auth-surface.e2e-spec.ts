import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import { clearAuthLimiterState } from './auth-helpers';
import { createTestApp } from './create-test-app';

const PASSWORD = 'a-sufficiently-long-password';

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/**
 * Integration test: requires the Compose stack with migrations applied.
 *
 * Exercises the mounted Better Auth surface end to end — the routing contract,
 * the body-parsing arrangement, and the verification flow — using the recorded
 * mail transport so no SMTP server is needed.
 */
describe('Authentication surface (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let redis: { del: (...keys: string[]) => Promise<number> };
  const createdEmails: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    redis = app.get(REDIS_CLIENT);

    // Counters from an earlier run would otherwise 429 these cases.
    await clearAuthLimiterState(app.get(REDIS_CLIENT));
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    await app.close();
  });

  async function signUp(email: string, name = 'Ada Lovelace') {
    createdEmails.push(email);

    return request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send({ email, password: PASSWORD, name });
  }

  function signIn(email: string, password = PASSWORD) {
    return request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .send({ email, password });
  }

  /** Follows a verification/reset link against the app under test. */
  function follow(link: string) {
    const url = new URL(link);
    return request(app.getHttpServer()).get(`${url.pathname}${url.search}`);
  }

  describe('routing contract', () => {
    it('serves the auth surface under /api/auth', async () => {
      const response = await signUp(uniqueEmail('routing'));

      expect(response.status).toBeLessThan(400);
    });

    it('does not serve the auth surface under the version segment', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/sign-in/email')
        .send({ email: 'nobody@example.test', password: PASSWORD });

      expect(response.status).toBe(404);
    });

    it('keeps health probes and the auth surface off /api/v1', async () => {
      await expect(
        request(app.getHttpServer())
          .get('/health/live')
          .then((res) => res.status),
      ).resolves.toBe(200);

      await expect(
        request(app.getHttpServer())
          .get('/api/v1/health/live')
          .then((res) => res.status),
      ).resolves.toBe(404);
    });
  });

  describe('request body reaches the handler', () => {
    it('reads a JSON body without hanging', async () => {
      const response = await signUp(uniqueEmail('jsonbody'));

      expect(response.status).toBeLessThan(400);
      expect(response.body).toBeDefined();
    });

    it('still parses bodies for application routes under /api/v1', async () => {
      // A route that does not exist still proves the parser ran rather than
      // hanging: a 404 comes back promptly with a JSON error envelope.
      const response = await request(app.getHttpServer())
        .post('/api/v1/does-not-exist')
        .send({ some: 'payload' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false });
    });
  });

  describe('request correlation', () => {
    it('returns a request id on the auth surface', async () => {
      const response = await signUp(uniqueEmail('correlation'));

      expect(response.headers['x-request-id']).toBeDefined();
    });

    it('propagates a supplied request id', async () => {
      const supplied = 'auth-surface-correlation-id';
      const response = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('x-request-id', supplied)
        .send({ email: 'nobody@example.test', password: PASSWORD });

      expect(response.headers['x-request-id']).toBe(supplied);
    });
  });

  describe('registration requires a verified address', () => {
    it('dispatches a verification message on sign-up', async () => {
      const email = uniqueEmail('verify-send');
      await signUp(email);

      const message = mail.lastTo(email);

      expect(message?.subject).toBe('Verify your email address');
      expect(mail.lastLinkTo(email)).toContain('/api/auth/');
    });

    it('refuses a session while the address is unverified', async () => {
      const email = uniqueEmail('unverified');
      await signUp(email);

      const response = await signIn(email);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    /**
     * The guard's own branch, which the case above cannot reach.
     *
     * Better Auth refuses to issue a session for an unverified address, so a
     * valid session on an unverified account only arises if verification is
     * revoked after the fact — an operator clearing the flag, or a data fix. The
     * flag is flipped directly here to construct exactly that state, because it is
     * the state `AuthGuard` exists to catch and otherwise nothing would exercise
     * it.
     *
     * The status is asserted alongside the code because both are the contract: a
     * `401` would tell the client to discard a session that is in fact valid and
     * sign in again, which cannot resolve an unverified address.
     */
    it('answers 403 EMAIL_NOT_VERIFIED for a valid session on an unverified account', async () => {
      const email = uniqueEmail('verified-then-revoked');
      createdEmails.push(email);
      await signUp(email);

      const link = mail.lastLinkTo(email);
      expect(link).toBeDefined();
      await follow(link as string);

      const signedIn = await signIn(email);
      const setCookie = (signedIn.headers['set-cookie'] ??
        []) as unknown as string[];
      const sessionCookie = setCookie.find((cookie) =>
        cookie.includes('session_token'),
      );
      expect(sessionCookie).toBeDefined();

      const cookiePair = (sessionCookie as string).split(';')[0];

      /**
       * The cookie value is `<token>.<signature>` — cookies are signed — while the
       * cache is keyed by the bare token, so the signature has to come off first.
       * Confirmed against the live keyspace: session entries are the 32-character
       * token alone.
       */
      const token = decodeURIComponent(cookiePair.split('=')[1] ?? '').split(
        '.',
      )[0];

      // Revoke verification behind the session's back.
      await prisma.user.update({
        where: { email },
        data: { emailVerified: false },
      });

      /**
       * The cached copy has to go too, and finding that out is worth recording.
       *
       * Better Auth caches the session **with its user record** in Redis, keyed by
       * the session token. So a database-only edit is invisible to `getSession`
       * until that entry expires — meaning revoking verification mid-session is not
       * observed while the session is cached. Narrow in practice (verification is
       * normally one-way, and Better Auth already refuses to issue a session for an
       * unverified address, which is the primary gate), so it is noted here rather
       * than treated as a defect in this change.
       *
       * Dropping the entry is what puts the guard in front of the authoritative
       * store, which is the branch under test.
       */
      await redis.del(token);

      const response = await request(app.getHttpServer())
        .get('/api/v1/account/me')
        .set('Cookie', cookiePair);

      expect(response.status).toBe(403);
      expect((response.body as { error?: { code?: string } }).error?.code).toBe(
        'EMAIL_NOT_VERIFIED',
      );
    });

    /** The sibling case, pinned so the two remain distinguishable. */
    it('answers 401 UNAUTHORIZED when no session is presented at all', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/account/me',
      );

      expect(response.status).toBe(401);
      expect((response.body as { error?: { code?: string } }).error?.code).toBe(
        'UNAUTHORIZED',
      );
    });

    it('establishes a session once verified', async () => {
      const email = uniqueEmail('verified');
      await signUp(email);

      const link = mail.lastLinkTo(email);
      expect(link).toBeDefined();
      await follow(link as string);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerified).toBe(true);

      const response = await signIn(email);

      expect(response.status).toBeLessThan(400);
      expect(response.headers['set-cookie']).toBeDefined();
    });

    it('rejects a password below the configured minimum', async () => {
      const email = uniqueEmail('shortpw');
      createdEmails.push(email);

      const response = await request(app.getHttpServer())
        .post('/api/auth/sign-up/email')
        .send({ email, password: 'short', name: 'Too Short' });

      expect(response.status).toBeGreaterThanOrEqual(400);
      await expect(prisma.user.count({ where: { email } })).resolves.toBe(0);
    });

    it('grants nothing when a verification link is replayed', async () => {
      const email = uniqueEmail('replay');
      await signUp(email);

      const link = mail.lastLinkTo(email) as string;
      await follow(link);
      const second = await follow(link);

      // Verification is idempotent by design: mail clients and link scanners
      // re-fetch these URLs, so a replay must not report a failure to a user who
      // did nothing wrong. What matters is that it confers nothing — no session,
      // and no second verification.
      expect(second.headers['set-cookie']).toBeUndefined();

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerified).toBe(true);

      // Still no session without signing in explicitly.
      const me = await request(app.getHttpServer()).get(
        '/api/auth/get-session',
      );
      expect(me.body).toBeFalsy();
    });
  });

  describe('session cookie hardening', () => {
    it('issues an HttpOnly, SameSite=Lax, root-path cookie', async () => {
      const email = uniqueEmail('cookie');
      await signUp(email);
      await follow(mail.lastLinkTo(email) as string);

      const response = await signIn(email);
      const cookies = response.headers['set-cookie'] as unknown as string[];
      const session = cookies.find((cookie) =>
        cookie.includes('session_token'),
      );

      expect(session).toBeDefined();
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Lax/i);
      expect(session).toMatch(/Path=\//);
      // APP_URL is http:// in tests, so Secure is correctly absent here.
      expect(session).not.toMatch(/Secure/i);
    });
  });

  describe('password reset', () => {
    it('accepts a reset request for a registered address', async () => {
      const email = uniqueEmail('reset-known');
      await signUp(email);
      await follow(mail.lastLinkTo(email) as string);
      mail.clear();

      const response = await request(app.getHttpServer())
        .post('/api/auth/request-password-reset')
        .send({ email, redirectTo: '/reset' });

      expect(response.status).toBeLessThan(400);
      expect(mail.lastTo(email)?.subject).toBe('Reset your password');
    });

    it('is indistinguishable for an unregistered address, and sends nothing', async () => {
      const known = uniqueEmail('reset-compare');
      await signUp(known);
      await follow(mail.lastLinkTo(known) as string);

      const knownResponse = await request(app.getHttpServer())
        .post('/api/auth/request-password-reset')
        .send({ email: known, redirectTo: '/reset' });

      const unknown = uniqueEmail('reset-absent');
      mail.clear();

      const unknownResponse = await request(app.getHttpServer())
        .post('/api/auth/request-password-reset')
        .send({ email: unknown, redirectTo: '/reset' });

      expect(unknownResponse.status).toBe(knownResponse.status);
      expect(unknownResponse.body).toEqual(knownResponse.body);
      expect(mail.lastTo(unknown)).toBeUndefined();
    });
  });

  describe('social providers', () => {
    it('does not route a provider whose credentials are absent', async () => {
      // No Google or Apple credentials are configured in the test environment.
      const response = await request(app.getHttpServer())
        .post('/api/auth/sign-in/social')
        .send({ provider: 'google', callbackURL: '/' });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.location).toBeUndefined();
    });
  });

  describe('response shape boundary', () => {
    it('returns the library shape, not the application envelope', async () => {
      const email = uniqueEmail('envelope');
      await signUp(email);
      await follow(mail.lastLinkTo(email) as string);

      const response = await signIn(email);

      expect(response.body).not.toHaveProperty('success');
      expect(response.body).not.toHaveProperty('meta');
      expect(response.body).not.toHaveProperty('data');
    });

    it('returns the library error shape on failure', async () => {
      const response = await signIn('definitely-absent@example.test');

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toHaveProperty('success');
    });
  });
});
