import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import type { MailRecorder } from '@infrastructure/mail/mail-recorder';
import type { PrismaService } from '@infrastructure/prisma/prisma.service';

export const TEST_PASSWORD = 'a-sufficiently-long-password';

/**
 * Drops rate-limit and lockout counters left over from an earlier run.
 *
 * Every suite signs in from the same address, and the library keys its
 * rate-limit counters as a bare `<ip>|<path>` with a window measured in seconds.
 * A previous run's counters therefore survive into the next one, which is how a
 * suite that has nothing to do with throttling ends up failing on a `429`.
 *
 * Call this in `beforeAll` of any suite that authenticates.
 */
export async function clearAuthLimiterState(client: {
  keys: (pattern: string) => Promise<string[]>;
  del: (...keys: string[]) => Promise<number>;
}): Promise<void> {
  for (const pattern of ['auth:lockout:*', '*|/*']) {
    const keys = await client.keys(pattern);

    if (keys.length > 0) {
      await client.del(...keys);
    }
  }
}

export function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@example.test`;
}

export interface TestUser {
  email: string;
  userId: string;
  /** Ready to pass to `.set('Cookie', …)`. */
  cookie: string;
  /** The same session token, for the bearer transport. */
  token: string;
}

interface Deps {
  app: NestExpressApplication;
  prisma: PrismaService;
  mail: MailRecorder;
}

/**
 * Registers a user, completes email verification through the recorded message,
 * signs in, and returns both session transports.
 *
 * Goes through the real HTTP surface rather than inserting rows: a session
 * fabricated in the database would not prove that the cookie, the bearer token,
 * and the verification gate actually work together.
 */
export async function createVerifiedUser(
  { app, prisma, mail }: Deps,
  label: string,
): Promise<TestUser> {
  const email = uniqueEmail(label);
  const server = app.getHttpServer();

  await request(server)
    .post('/api/auth/sign-up/email')
    .send({ email, password: TEST_PASSWORD, name: 'Test User' })
    .expect((response) => {
      if (response.status >= 400) {
        throw new Error(
          `sign-up failed (${response.status}): ${JSON.stringify(response.body)}`,
        );
      }
    });

  const link = mail.lastLinkTo(email);
  if (!link) {
    throw new Error(`no verification message was recorded for ${email}`);
  }

  const verifyUrl = new URL(link);
  await request(server).get(`${verifyUrl.pathname}${verifyUrl.search}`);

  const signIn = await request(server)
    .post('/api/auth/sign-in/email')
    .send({ email, password: TEST_PASSWORD });

  if (signIn.status >= 400) {
    throw new Error(
      `sign-in failed (${signIn.status}): ${JSON.stringify(signIn.body)}`,
    );
  }

  const setCookie = (signIn.headers['set-cookie'] ?? []) as unknown as string[];
  const sessionCookie = setCookie.find((cookie) =>
    cookie.includes('session_token'),
  );

  if (!sessionCookie) {
    throw new Error(`no session cookie was issued for ${email}`);
  }

  const cookie = sessionCookie.split(';')[0];
  const token = decodeURIComponent(cookie.split('=')[1] ?? '');

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  return { email, userId: user.id, cookie, token };
}

/** Grants a role by name, the way an operator would until admin APIs exist. */
export async function grantRole(
  prisma: PrismaService,
  userId: string,
  roleName: string,
): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: roleName },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    update: {},
    create: { userId, roleId: role.id },
  });
}

export async function revokeRole(
  prisma: PrismaService,
  userId: string,
  roleName: string,
): Promise<void> {
  const role = await prisma.role.findUnique({ where: { name: roleName } });

  if (role) {
    await prisma.userRole.deleteMany({ where: { userId, roleId: role.id } });
  }
}
