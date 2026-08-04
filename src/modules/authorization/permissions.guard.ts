import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { RequestContext } from '@common/context/request-context';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import {
  IS_PUBLIC_KEY,
  PRINCIPAL_REQUEST_KEY,
} from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import {
  REQUIRED_PERMISSIONS_KEY,
  REQUIRED_ROLES_KEY,
} from './authorization.decorators';
import {
  type EffectiveAccess,
  PermissionResolver,
} from './permission-resolver.service';

/** Where the resolved access set is cached for the remainder of the request. */
const ACCESS_REQUEST_KEY = 'authzAccess';

/**
 * Stage two of the chain: decide whether the established caller may proceed.
 *
 * Consumes the principal `AuthGuard` resolved rather than resolving the session
 * again, and resolves the effective access set at most once per request even when
 * several requirements are evaluated.
 *
 * Later capabilities extend the chain after this one — plan entitlements, then
 * throttling and usage limits, then credit checks — in that order, and likewise
 * read the already-resolved principal instead of re-deriving it.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolver,
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

    /**
     * `getAllAndOverride` gives method-level annotations precedence over
     * controller-level ones, which is what makes a per-method override work.
     */
    const requiredPermissions =
      this.reflector.getAllAndOverride<string[] | undefined>(
        REQUIRED_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    const acceptedRoles =
      this.reflector.getAllAndOverride<string[] | undefined>(
        REQUIRED_ROLES_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    if (requiredPermissions.length === 0 && acceptedRoles.length === 0) {
      // Authenticated is the requirement; AuthGuard already enforced it.
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const principal = this.principalOf(request);
    const access = await this.accessFor(request, principal.id);

    // Every listed permission must be held.
    const missing = requiredPermissions.filter(
      (permission) => !access.permissions.includes(permission),
    );

    if (missing.length > 0) {
      this.deny(
        context,
        principal,
        `missing permission(s): ${missing.join(', ')}`,
      );
    }

    // Any one of the listed roles suffices.
    if (
      acceptedRoles.length > 0 &&
      !acceptedRoles.some((role) => access.roles.includes(role))
    ) {
      this.deny(
        context,
        principal,
        `requires one of role(s): ${acceptedRoles.join(', ')}`,
      );
    }

    return true;
  }

  private principalOf(request: Request): AuthenticatedPrincipal {
    const principal = (
      request as Request & {
        [PRINCIPAL_REQUEST_KEY]?: AuthenticatedPrincipal;
      }
    )[PRINCIPAL_REQUEST_KEY];

    if (!principal) {
      // AuthGuard runs first and either sets this or throws, so reaching here
      // means the guards were registered out of order.
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
      );
    }

    return principal;
  }

  /** Resolved once per request, however many requirements are evaluated. */
  private async accessFor(
    request: Request,
    userId: string,
  ): Promise<EffectiveAccess> {
    const carrier = request as Request & {
      [ACCESS_REQUEST_KEY]?: EffectiveAccess;
    };

    carrier[ACCESS_REQUEST_KEY] ??= await this.resolver.resolve(userId);

    return carrier[ACCESS_REQUEST_KEY];
  }

  /**
   * Logs what was actually missing, and tells the client only that it was
   * refused — an error that enumerates the policy describes the policy to an
   * attacker.
   */
  private deny(
    context: ExecutionContext,
    principal: AuthenticatedPrincipal,
    reason: string,
  ): never {
    const request = context.switchToHttp().getRequest<Request>();

    this.logger.warn({
      msg: 'Authorization denied',
      requestId: RequestContext.getRequestId(),
      userId: principal.id,
      route: `${request.method} ${request.originalUrl}`,
      reason,
    });

    throw new ApiException(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      'You do not have access to this resource.',
    );
  }
}
