import { Inject, Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';

import type { AuthInstance } from './auth.factory';
import { AUTH_INSTANCE } from './auth.tokens';

export interface AuthenticatedPrincipal {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
}

export interface ResolvedSession {
  user: AuthenticatedPrincipal;
  sessionId: string;
  expiresAt: Date;
}

/**
 * The one place a session is resolved from a request.
 *
 * Both transports land here: the cookie and the `Authorization: Bearer` header
 * are read by the same call, so they cannot drift in expiry or revocation
 * behaviour. Guards further down the chain consume what this produced rather
 * than resolving again — see the `authorization` capability.
 */
@Injectable()
export class AuthService {
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: AuthInstance) {}

  async resolveSession(request: Request): Promise<ResolvedSession | null> {
    const result = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!result) {
      return null;
    }

    const { user, session } = result;

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled ?? false,
      },
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }
}
