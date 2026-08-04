import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  TEST_PASSWORD,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';

/**
 * Derives a live code from the provisioning URI, as an authenticator app would.
 *
 * The URI carries the secret base32-encoded, but the verifier derives codes from
 * the **raw** secret (`createOTP(generateRandomString(32))`, base32-encoded only
 * by `.url()`). Passing the encoded form straight through yields codes that
 * always fail, so it has to be decoded first.
 */
async function totpFrom(totpUri: string): Promise<string> {
  const encoded = new URL(totpUri).searchParams.get('secret');

  if (!encoded) {
    throw new Error(`no secret in provisioning URI: ${totpUri}`);
  }

  const raw = new TextDecoder().decode(base32.decode(encoded));

  return createOTP(raw, { digits: 6, period: 30 }).totp();
}

/**
 * Integration test: requires the Compose stack with migrations applied.
 *
 * Uses the same OTP implementation the verifier uses (`@better-auth/utils`,
 * pinned to the version better-auth itself depends on) so the codes are real
 * rather than stubbed.
 */
describe('Two-factor authentication (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
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

  async function freshUser(label: string): Promise<TestUser> {
    const user = await createVerifiedUser({ app, prisma, mail }, label);
    createdUserIds.push(user.userId);
    return user;
  }

  const server = () => app.getHttpServer();

  const post = (path: string, user: TestUser) =>
    request(server()).post(path).set('Cookie', user.cookie);

  /** The session cookie from a response, if it rotated one. */
  function rotatedCookie(response: request.Response): string | undefined {
    const cookies = (response.headers['set-cookie'] ??
      []) as unknown as string[];

    return cookies
      .find((cookie) => cookie.includes('session_token'))
      ?.split(';')[0];
  }

  /**
   * Enrols and activates 2FA, returning the URI and the issued backup codes.
   *
   * Mutates `user.cookie` as it goes: `enableTwoFactor` deletes the current
   * session and issues a replacement, so holding onto the original cookie would
   * make every later request in the test 401 for reasons unrelated to what it is
   * asserting.
   */
  async function enrol(user: TestUser) {
    const enable = await post('/api/v1/account/two-factor/enable', user).send({
      password: TEST_PASSWORD,
    });

    expect(enable.status).toBeLessThan(400);
    user.cookie = rotatedCookie(enable) ?? user.cookie;

    const { totpURI, backupCodes } = enable.body.data as {
      totpURI: string;
      backupCodes: string[];
    };

    const verify = await post('/api/v1/account/two-factor/verify', user).send({
      code: await totpFrom(totpURI),
    });

    expect(verify.status).toBeLessThan(400);
    user.cookie = rotatedCookie(verify) ?? user.cookie;

    return { totpURI, backupCodes };
  }

  describe('enrolment', () => {
    it('requires the password to issue a secret', async () => {
      const user = await freshUser('tfa-nopw');

      const response = await post(
        '/api/v1/account/two-factor/enable',
        user,
      ).send({});

      expect(response.status).toBe(400);
    });

    it('issues an issuer-labelled provisioning URI', async () => {
      const user = await freshUser('tfa-uri');

      const response = await post(
        '/api/v1/account/two-factor/enable',
        user,
      ).send({ password: TEST_PASSWORD });

      const { totpURI } = response.body.data as { totpURI: string };

      expect(totpURI).toMatch(/^otpauth:\/\/totp\//);
      expect(decodeURIComponent(totpURI)).toContain(
        'NestJS Enterprise Starter',
      );
    });

    it('does not activate until a valid code is submitted', async () => {
      const user = await freshUser('tfa-unconfirmed');

      await post('/api/v1/account/two-factor/enable', user).send({
        password: TEST_PASSWORD,
      });

      // Secret issued but never confirmed: password-only sign-in still works.
      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: TEST_PASSWORD });

      expect(signIn.status).toBeLessThan(400);
      expect(signIn.body.twoFactorRedirect).toBeFalsy();
    });

    it('rejects an incorrect code without activating', async () => {
      const user = await freshUser('tfa-badcode');

      await post('/api/v1/account/two-factor/enable', user).send({
        password: TEST_PASSWORD,
      });

      const verify = await post('/api/v1/account/two-factor/verify', user).send(
        { code: '000000' },
      );

      expect(verify.status).toBeGreaterThanOrEqual(400);

      const status = await request(server())
        .get('/api/v1/account/two-factor')
        .set('Cookie', user.cookie);

      expect(status.body.data.enabled).toBe(false);
    });

    it('activates on a valid code and issues backup codes', async () => {
      const user = await freshUser('tfa-activate');
      const { backupCodes } = await enrol(user);

      expect(backupCodes.length).toBeGreaterThan(0);

      const status = await request(server())
        .get('/api/v1/account/two-factor')
        .set('Cookie', user.cookie);

      expect(status.body.data).toMatchObject({ enabled: true });
      expect(status.body.data.backupCodesRemaining).toBe(backupCodes.length);
    });
  });

  describe('a correct password yields a challenge, not a session', () => {
    it('returns a two-factor challenge instead of a usable session', async () => {
      const user = await freshUser('tfa-challenge');
      await enrol(user);

      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: TEST_PASSWORD });

      expect(signIn.status).toBeLessThan(400);
      expect(signIn.body.twoFactorRedirect).toBe(true);
      expect(signIn.body.token).toBeFalsy();
    });

    it('leaves protected routes unreachable while the challenge is outstanding', async () => {
      const user = await freshUser('tfa-pending');
      await enrol(user);

      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: TEST_PASSWORD });

      const pending = (signIn.headers['set-cookie'] ??
        []) as unknown as string[];

      const response = await request(server())
        .get('/api/v1/account/two-factor')
        .set('Cookie', pending.map((c) => c.split(';')[0]).join('; '));

      expect(response.status).toBe(401);
    });

    it('does not reveal that 2FA is active when the password is wrong', async () => {
      const enrolled = await freshUser('tfa-wrongpw');
      await enrol(enrolled);

      const withTwoFactor = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: enrolled.email, password: 'not-the-password' });

      const plain = await freshUser('tfa-plain');
      const withoutTwoFactor = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: plain.email, password: 'not-the-password' });

      expect(withTwoFactor.status).toBe(withoutTwoFactor.status);
      expect(withTwoFactor.body).toEqual(withoutTwoFactor.body);
    });

    it('completes the challenge with a valid TOTP code', async () => {
      const user = await freshUser('tfa-complete');
      const { totpURI } = await enrol(user);

      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: TEST_PASSWORD });

      const pending = (
        (signIn.headers['set-cookie'] ?? []) as unknown as string[]
      )
        .map((c) => c.split(';')[0])
        .join('; ');

      const verify = await request(server())
        .post('/api/auth/two-factor/verify-totp')
        .set('Cookie', pending)
        .send({ code: await totpFrom(totpURI) });

      expect(verify.status).toBeLessThan(400);

      const session = (
        (verify.headers['set-cookie'] ?? []) as unknown as string[]
      )
        .map((c) => c.split(';')[0])
        .join('; ');

      const response = await request(server())
        .get('/api/v1/account/two-factor')
        .set('Cookie', session);

      expect(response.status).toBe(200);
    });
  });

  describe('backup codes', () => {
    it('accepts an unused code once and refuses it thereafter', async () => {
      const user = await freshUser('tfa-backup');
      const { backupCodes } = await enrol(user);
      const code = backupCodes[0];

      const challenge = async () => {
        const signIn = await request(server())
          .post('/api/auth/sign-in/email')
          .send({ email: user.email, password: TEST_PASSWORD });

        return ((signIn.headers['set-cookie'] ?? []) as unknown as string[])
          .map((c) => c.split(';')[0])
          .join('; ');
      };

      const first = await request(server())
        .post('/api/auth/two-factor/verify-backup-code')
        .set('Cookie', await challenge())
        .send({ code });

      expect(first.status).toBeLessThan(400);

      const second = await request(server())
        .post('/api/auth/two-factor/verify-backup-code')
        .set('Cookie', await challenge())
        .send({ code });

      expect(second.status).toBeGreaterThanOrEqual(400);
    });

    it('stores codes so the persisted form is not usable as a code', async () => {
      const user = await freshUser('tfa-storage');
      const { backupCodes } = await enrol(user);

      const record = await prisma.twoFactor.findFirstOrThrow({
        where: { userId: user.userId },
      });

      /**
       * The library's default would store these as plaintext JSON; the factory
       * sets `storeBackupCodes: 'encrypted'` precisely so this assertion holds.
       */
      for (const code of backupCodes) {
        expect(record.backupCodes).not.toContain(code);
      }
    });

    it('reports the remaining count, decreasing as codes are consumed', async () => {
      const user = await freshUser('tfa-count');
      const { backupCodes } = await enrol(user);

      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: TEST_PASSWORD });

      const pending = (
        (signIn.headers['set-cookie'] ?? []) as unknown as string[]
      )
        .map((c) => c.split(';')[0])
        .join('; ');

      const used = await request(server())
        .post('/api/auth/two-factor/verify-backup-code')
        .set('Cookie', pending)
        .send({ code: backupCodes[0] });

      const session = (
        (used.headers['set-cookie'] ?? []) as unknown as string[]
      )
        .map((c) => c.split(';')[0])
        .join('; ');

      const status = await request(server())
        .get('/api/v1/account/two-factor')
        .set('Cookie', session);

      expect(status.body.data.backupCodesRemaining).toBe(
        backupCodes.length - 1,
      );
    });

    it('invalidates the previous set when codes are re-issued', async () => {
      const user = await freshUser('tfa-reissue');
      const { backupCodes } = await enrol(user);

      const reissued = await post(
        '/api/v1/account/two-factor/backup-codes',
        user,
      ).send({ password: TEST_PASSWORD });

      expect(reissued.status).toBeLessThan(400);

      const fresh = (reissued.body.data as { backupCodes: string[] })
        .backupCodes;
      expect(fresh).not.toEqual(backupCodes);

      // An old code no longer satisfies a challenge.
      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: TEST_PASSWORD });

      const pending = (
        (signIn.headers['set-cookie'] ?? []) as unknown as string[]
      )
        .map((c) => c.split(';')[0])
        .join('; ');

      const response = await request(server())
        .post('/api/auth/two-factor/verify-backup-code')
        .set('Cookie', pending)
        .send({ code: backupCodes[0] });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses to re-issue without the password', async () => {
      const user = await freshUser('tfa-reissue-nopw');
      await enrol(user);

      const response = await post(
        '/api/v1/account/two-factor/backup-codes',
        user,
      ).send({});

      expect(response.status).toBe(400);
    });
  });

  describe('disabling', () => {
    it('requires the password', async () => {
      const user = await freshUser('tfa-disable-nopw');
      await enrol(user);

      const response = await post(
        '/api/v1/account/two-factor/disable',
        user,
      ).send({});

      expect(response.status).toBe(400);

      const status = await request(server())
        .get('/api/v1/account/two-factor')
        .set('Cookie', user.cookie);

      expect(status.body.data.enabled).toBe(true);
    });

    it('clears the secret and every backup code', async () => {
      const user = await freshUser('tfa-disable');
      await enrol(user);

      const response = await post(
        '/api/v1/account/two-factor/disable',
        user,
      ).send({ password: TEST_PASSWORD });

      expect(response.status).toBeLessThan(400);

      const remaining = await prisma.twoFactor.count({
        where: { userId: user.userId },
      });
      expect(remaining).toBe(0);

      // Password alone signs in again.
      const signIn = await request(server())
        .post('/api/auth/sign-in/email')
        .send({ email: user.email, password: TEST_PASSWORD });

      expect(signIn.body.twoFactorRedirect).toBeFalsy();
    });
  });
});
