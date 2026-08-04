import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RequestContext } from '@common/context/request-context';

import { PRINCIPAL_REQUEST_KEY } from './auth.decorators';
import { AuthGuard } from './auth.guard';
import type { AuthService, ResolvedSession } from './auth.service';

const VERIFIED: ResolvedSession = {
  user: {
    id: 'user-1',
    email: 'ada@example.test',
    name: 'Ada',
    emailVerified: true,
    twoFactorEnabled: false,
  },
  sessionId: 'session-1',
  expiresAt: new Date(Date.now() + 60_000),
};

const UNVERIFIED: ResolvedSession = {
  ...VERIFIED,
  user: { ...VERIFIED.user, emailVerified: false },
};

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWith(
  session: ResolvedSession | null,
  isPublic = false,
): { guard: AuthGuard; resolve: jest.Mock } {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockReturnValue(isPublic ? true : undefined);

  const resolve = jest.fn().mockResolvedValue(session);
  const authService = { resolveSession: resolve } as unknown as AuthService;

  return { guard: new AuthGuard(reflector, authService), resolve };
}

describe('AuthGuard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a request presenting no session', async () => {
    const { guard } = guardWith(null);

    await expect(guard.canActivate(contextFor({}))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });

  it('distinguishes an unverified address from a missing session', async () => {
    const { guard } = guardWith(UNVERIFIED);

    /**
     * Better Auth already refuses to issue a session for an unverified account,
     * so this is a second line — but it is the line that decides what a client
     * is told, and "verify your email" and "sign in" are different remedies.
     */
    await expect(guard.canActivate(contextFor({}))).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
      status: 403,
    });
  });

  it('admits a verified session and publishes the principal', async () => {
    const { guard } = guardWith(VERIFIED);
    const request: Record<string, unknown> = {};

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request[PRINCIPAL_REQUEST_KEY]).toMatchObject({
      id: 'user-1',
      email: 'ada@example.test',
    });
  });

  it('records the principal on the request context for logging and deep reads', async () => {
    const { guard } = guardWith(VERIFIED);

    await RequestContext.run({ requestId: 'req-1' }, async () => {
      await guard.canActivate(contextFor({}));

      expect(RequestContext.getUserId()).toBe('user-1');
    });
  });

  it('skips a public route without resolving a session at all', async () => {
    const { guard, resolve } = guardWith(null, true);

    await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves the session exactly once per request', async () => {
    const { guard, resolve } = guardWith(VERIFIED);

    await guard.canActivate(contextFor({}));

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('leaves non-HTTP contexts alone', async () => {
    const { guard, resolve } = guardWith(null);
    const context = {
      getType: () => 'rpc',
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
});
