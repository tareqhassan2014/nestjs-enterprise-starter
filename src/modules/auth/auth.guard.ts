import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { RequestContext } from '@common/context/request-context';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

import { IS_PUBLIC_KEY, PRINCIPAL_REQUEST_KEY } from './auth.decorators';
import { type AuthenticatedPrincipal, AuthService } from './auth.service';

/**
 * Stage one of the chain: establish who is calling.
 *
 * Deny-by-default — a route with no annotations requires a session, so a newly
 * added controller is protected before anyone considers protecting it. `@Public()`
 * is the only way out.
 *
 * Resolves the session exactly once and publishes the result twice: on the
 * request (for `@CurrentUser()` and `PermissionsGuard`) and on the
 * AsyncLocalStorage store (for logging and for code with no HTTP awareness).
 * Later stages consume that; they must not resolve again.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const session = await this.authService.resolveSession(request);

    if (!session) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
      );
    }

    /**
     * A verified address is a precondition for using the API, but it is a
     * different failure from "no session": the client's remedy is to verify, not
     * to sign in again. Better Auth also refuses to issue a session for an
     * unverified account, so this is a second line rather than the only one.
     */
    if (!session.user.emailVerified) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Verify your email address before using this resource.',
      );
    }

    this.publish(request, session.user);

    return true;
  }

  private publish(request: Request, principal: AuthenticatedPrincipal): void {
    (request as Request & Record<string, unknown>)[PRINCIPAL_REQUEST_KEY] =
      principal;

    // Makes the actor readable from anywhere in the call stack, and puts it on
    // every log line emitted from here on.
    RequestContext.setUserId(principal.id);
  }
}
