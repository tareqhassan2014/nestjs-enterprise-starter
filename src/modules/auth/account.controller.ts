import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';

import { PermissionResolver } from '@modules/authorization/permission-resolver.service';

import { CurrentUser } from './auth.decorators';
import type { AuthInstance } from './auth.factory';
import { type AuthenticatedPrincipal, AuthService } from './auth.service';
import { AUTH_INSTANCE } from './auth.tokens';

interface CurrentPrincipalView {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  roles: string[];
  permissions: string[];
}

interface SessionView {
  id: string;
  current: boolean;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * The caller's own account: who they are, and which sessions they hold.
 *
 * First-party controllers, so these use the standard response envelope — unlike
 * the library-owned surface at `/api/auth/*`. Scoped to the *current* user
 * throughout: managing somebody else's roles or sessions belongs to the
 * admin-monitoring change, which has an HTTP surface to design for it.
 */
@Controller({ path: 'account', version: '1' })
export class AccountController {
  constructor(
    @Inject(AUTH_INSTANCE) private readonly auth: AuthInstance,
    private readonly authService: AuthService,
    private readonly permissions: PermissionResolver,
  ) {}

  /** The authenticated principal, with effective roles and permissions. */
  @Get('me')
  async me(
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<CurrentPrincipalView> {
    const access = await this.permissions.resolve(user.id);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      roles: access.roles,
      permissions: access.permissions,
    };
  }

  /**
   * Every session the caller holds, with the current one flagged.
   *
   * This is what makes database-backed sessions worth their cost: a user can see
   * where they are signed in and cut off anything they do not recognise.
   */
  @Get('sessions')
  async sessions(@Req() request: Request): Promise<SessionView[]> {
    const headers = fromNodeHeaders(request.headers);

    const [current, all] = await Promise.all([
      this.authService.resolveSession(request),
      this.auth.api.listSessions({ headers }),
    ]);

    return all.map((session) => ({
      id: session.id,
      current: session.id === current?.sessionId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress ?? null,
      userAgent: session.userAgent ?? null,
    }));
  }

  /**
   * Revokes one of the caller's own sessions.
   *
   * Takes effect on that session's next request: there is no signed-cookie
   * session cache in front of the store, which is exactly why `cookieCache` is
   * left disabled.
   */
  @Delete('sessions/:id')
  async revokeSession(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<{ revoked: true }> {
    const headers = fromNodeHeaders(request.headers);
    const sessions = await this.auth.api.listSessions({ headers });

    // Only the caller's own sessions are listed, so an id absent from this list
    // is one they may not touch. Reported as revoked either way, so the endpoint
    // does not confirm whether another user's session id exists.
    const target = sessions.find((session) => session.id === id);

    if (target) {
      await this.auth.api.revokeSession({
        body: { token: target.token },
        headers,
      });
    }

    return { revoked: true };
  }

  /** Signs out everywhere else, keeping the current session. */
  @Post('sessions/revoke-others')
  async revokeOtherSessions(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ revoked: true }> {
    const result = await this.auth.api.revokeOtherSessions({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });

    // This endpoint can rotate the current session's cookie; dropping it would
    // sign the caller out of the one session they asked to keep.
    for (const cookie of result.headers.getSetCookie()) {
      response.append('set-cookie', cookie);
    }

    return { revoked: true };
  }
}
