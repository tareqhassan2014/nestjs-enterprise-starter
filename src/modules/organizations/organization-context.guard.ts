import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { RequestContext } from '@common/context/request-context';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { shutdownConfig } from '@config/shutdown.config';
import {
  IS_PUBLIC_KEY,
  PRINCIPAL_REQUEST_KEY,
} from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { OrganizationsService } from './organizations.service';

/**
 * Binds `ORGANIZATION_HEADER` to the request context after verifying
 * membership — never from the header value alone (see design.md, "Org
 * header spoofing" risk). A no-op when the header is absent: user-primary
 * stays the default and every existing route is unaffected.
 *
 * Runs after `AuthGuard` / `PermissionsGuard` (module import order in
 * `AppModule`) so it can read the resolved principal, and before
 * `EntitlementsGuard` / `ThrottlingModule` / `UsageLimitsModule` /
 * `CreditsModule` so their billing-subject resolution sees the binding. It
 * annotates context; it does not itself gate on plan/throttle/usage/credits.
 */
@Injectable()
export class OrganizationContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly organizations: OrganizationsService,
    @Inject(shutdownConfig.KEY)
    private readonly config: ConfigType<typeof shutdownConfig>,
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
    const headerValue = request.headers[this.config.organizationHeader];
    const organizationId = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;

    if (!organizationId) {
      return true;
    }

    const principal = this.principalOf(request);
    const membership = await this.organizations.getMembership(
      organizationId,
      principal.id,
    );

    if (!membership) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'You are not a member of this organization.',
        { organizationId },
      );
    }

    RequestContext.setOrganizationId(organizationId);

    return true;
  }

  private principalOf(request: Request): AuthenticatedPrincipal {
    const principal = (
      request as Request & {
        [PRINCIPAL_REQUEST_KEY]?: AuthenticatedPrincipal;
      }
    )[PRINCIPAL_REQUEST_KEY];

    if (!principal) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
      );
    }

    return principal;
  }
}
