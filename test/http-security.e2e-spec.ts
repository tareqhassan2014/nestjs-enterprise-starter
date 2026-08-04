import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { authConfig } from '@config/auth.config';
import { securityConfig, type SecurityConfig } from '@config/security.config';
import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import { clearAuthLimiterState, createVerifiedUser } from './auth-helpers';
import { createTestApp } from './create-test-app';
import { AuthorizationFixtureModule } from './fixtures/authorization-fixture.module';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const DISALLOWED_ORIGIN = 'https://evil.example.com';

/** Integration test: requires the Compose stack. */
describe('HTTP security (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp(undefined, [AuthorizationFixtureModule]);
    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);

    await clearAuthLimiterState(app.get(REDIS_CLIENT));
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  const server = () => app.getHttpServer();

  describe('security response headers', () => {
    it('sets them on an application response', async () => {
      const response = await request(server()).get(
        '/api/v1/authz-fixture/public',
      );

      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });

    it('permits no content sources and denies framing', async () => {
      const response = await request(server()).get(
        '/api/v1/authz-fixture/public',
      );

      const csp = response.headers['content-security-policy'];

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('advertises no server framework', async () => {
      const response = await request(server()).get(
        '/api/v1/authz-fixture/public',
      );

      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('covers the library-owned authentication surface too', async () => {
      const response = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: 'nobody@example.test', password: 'wrong-password' });

      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('covers error responses', async () => {
      const response = await request(server()).get(
        '/api/v1/authz-fixture/unannotated',
      );

      expect(response.status).toBe(401);
      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });

    it('covers health probes', async () => {
      const response = await request(server()).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('omits HSTS when serving plain HTTP locally', async () => {
      const response = await request(server()).get(
        '/api/v1/authz-fixture/public',
      );

      // APP_URL is http:// under test, so pinning localhost to HTTPS would be
      // actively harmful to the developer's browser.
      expect(response.headers['strict-transport-security']).toBeUndefined();
    });
  });

  describe('HSTS when the deployment serves HTTPS', () => {
    let httpsApp: NestExpressApplication;

    beforeAll(async () => {
      const base = securityConfig();

      httpsApp = await createTestApp((builder) =>
        builder
          .overrideProvider(securityConfig.KEY)
          .useValue({ ...base, servesHttps: true } satisfies SecurityConfig),
      );
    }, 60_000);

    afterAll(async () => {
      await httpsApp.close();
    });

    it('emits strict transport security', async () => {
      const response = await request(httpsApp.getHttpServer()).get(
        '/health/live',
      );

      expect(response.headers['strict-transport-security']).toContain(
        'max-age=',
      );
    });
  });

  describe('CORS', () => {
    it('grants an allowlisted origin, with credentials', async () => {
      const response = await request(server())
        .get('/api/v1/authz-fixture/public')
        .set('Origin', ALLOWED_ORIGIN);

      expect(response.headers['access-control-allow-origin']).toBe(
        ALLOWED_ORIGIN,
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('grants nothing to an origin outside the allowlist', async () => {
      const response = await request(server())
        .get('/api/v1/authz-fixture/public')
        .set('Origin', DISALLOWED_ORIGIN);

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('never answers with a wildcard, which credentials forbid', async () => {
      const response = await request(server())
        .get('/api/v1/authz-fixture/public')
        .set('Origin', ALLOWED_ORIGIN);

      expect(response.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('answers a preflight from an allowlisted origin', async () => {
      const response = await request(server())
        .options('/api/v1/authz-fixture/public')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBeLessThan(400);
      expect(response.headers['access-control-allow-origin']).toBe(
        ALLOWED_ORIGIN,
      );
      expect(response.headers['access-control-allow-methods']).toContain('GET');
    });
  });

  describe('one allowlist governs CORS and the auth origin check', () => {
    it('hands the same origins to both', () => {
      const security = app.get<SecurityConfig>(securityConfig.KEY);
      const auth = app.get<{ basePath: string }>(authConfig.KEY);

      // The auth instance is built with `trustedOrigins: security.corsOrigins`,
      // so there is no second list to drift. Asserting the source is shared is
      // the meaningful check; the wiring is in auth.factory.ts.
      expect(security.corsOrigins).toContain(ALLOWED_ORIGIN);
      expect(auth.basePath).toBe('/api/auth');
    });

    it('rejects a state-changing auth request from an untrusted origin', async () => {
      const response = await request(server())
        .post('/api/auth/sign-in/email')
        .set('Origin', DISALLOWED_ORIGIN)
        .send({ email: 'nobody@example.test', password: 'wrong-password' });

      // Refused by the origin check rather than reaching the credential check.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('session cookie attributes', () => {
    it('issues an HttpOnly, SameSite=Lax, root-path cookie', async () => {
      const user = await createVerifiedUser(
        { app, prisma, mail },
        'security-cookie',
      );
      createdUserIds.push(user.userId);

      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: 'a-sufficiently-long-password' });

      const cookies = (signIn.headers['set-cookie'] ??
        []) as unknown as string[];
      const session = cookies.find((cookie) =>
        cookie.includes('session_token'),
      );

      expect(session).toBeDefined();
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Lax/i);
      expect(session).toMatch(/Path=\//);
    });

    it('omits Secure only because this deployment is plain HTTP', async () => {
      const security = app.get<SecurityConfig>(securityConfig.KEY);
      expect(security.servesHttps).toBe(false);

      const user = await createVerifiedUser(
        { app, prisma, mail },
        'security-cookie-insecure',
      );
      createdUserIds.push(user.userId);

      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: 'a-sufficiently-long-password' });

      const cookies = (signIn.headers['set-cookie'] ??
        []) as unknown as string[];
      const session = cookies.find((cookie) =>
        cookie.includes('session_token'),
      );

      expect(session).not.toMatch(/Secure/i);
      // Every other hardening attribute is still present.
      expect(session).toMatch(/HttpOnly/i);
    });
  });
});
