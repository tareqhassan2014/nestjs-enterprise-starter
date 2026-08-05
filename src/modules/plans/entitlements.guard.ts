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

import type { Entitlement, PlanSlug } from './entitlements';
import {
  REQUIRED_ENTITLEMENTS_KEY,
  REQUIRED_PLAN_KEY,
} from './plan.decorators';
import {
  type EffectivePlan,
  PlanResolutionService,
} from './plan-resolution.service';

/** Where the resolved plan is cached for the remainder of the request. */
export const EFFECTIVE_PLAN_REQUEST_KEY = 'plansEffective';

/**
 * Stage three of the chain: commercial entitlements after RBAC.
 *
 * No-op when the route carries neither `@RequireEntitlement` nor
 * `@RequirePlan`. Consumes the principal AuthGuard already resolved.
 */
@Injectable()
export class EntitlementsGuard implements CanActivate {
  private readonly logger = new Logger(EntitlementsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly plans: PlanResolutionService,
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

    const requiredEntitlements =
      this.reflector.getAllAndOverride<Entitlement[] | undefined>(
        REQUIRED_ENTITLEMENTS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    const requiredPlan = this.reflector.getAllAndOverride<
      PlanSlug | undefined
    >(REQUIRED_PLAN_KEY, [context.getHandler(), context.getClass()]);

    if (requiredEntitlements.length === 0 && !requiredPlan) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const principal = this.principalOf(request);
    const plan = await this.planFor(request, principal.id);

    const missing = requiredEntitlements.filter(
      (key) => !this.plans.hasEntitlement(plan, key),
    );

    if (missing.length > 0) {
      this.deny(
        context,
        principal,
        `missing entitlement(s): ${missing.join(', ')}`,
      );
    }

    if (requiredPlan && !this.plans.meetsMinimumPlan(plan, requiredPlan)) {
      this.deny(
        context,
        principal,
        `requires minimum plan: ${requiredPlan} (effective: ${plan.slug})`,
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
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
      );
    }

    return principal;
  }

  private async planFor(
    request: Request,
    userId: string,
  ): Promise<EffectivePlan> {
    const carrier = request as Request & {
      [EFFECTIVE_PLAN_REQUEST_KEY]?: EffectivePlan;
    };

    carrier[EFFECTIVE_PLAN_REQUEST_KEY] ??= await this.plans.resolve(userId);

    return carrier[EFFECTIVE_PLAN_REQUEST_KEY];
  }

  private deny(
    context: ExecutionContext,
    principal: AuthenticatedPrincipal,
    reason: string,
  ): never {
    const request = context.switchToHttp().getRequest<Request>();

    this.logger.warn({
      msg: 'Entitlement denied',
      requestId: RequestContext.getRequestId(),
      userId: principal.id,
      route: `${request.method} ${request.originalUrl}`,
      reason,
    });

    throw new ApiException(
      HttpStatus.FORBIDDEN,
      ErrorCode.ENTITLEMENT_DENIED,
      'Your plan does not include this feature.',
    );
  }
}
