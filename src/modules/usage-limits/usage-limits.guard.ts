import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PRINCIPAL_REQUEST_KEY } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { USAGE_LIMIT_KEY } from './usage-limit.decorator';
import type { UsageFeature } from './usage-features';
import { UsageLimitsService } from './usage-limits.service';

/**
 * Optional route metering. No-op unless `@UsageLimit(feature)` is present.
 * Consumes the principal AuthGuard already resolved — does not look up the
 * session again. Runs after Nest throttling in the APP_GUARD chain.
 */
@Injectable()
export class UsageLimitsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usageLimits: UsageLimitsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const feature = this.reflector.getAllAndOverride<UsageFeature | undefined>(
      USAGE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!feature) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<
        Request & { [PRINCIPAL_REQUEST_KEY]?: AuthenticatedPrincipal }
      >();
    const principal = request[PRINCIPAL_REQUEST_KEY];

    if (!principal) {
      // Annotated on a @Public route without a principal — programming error.
      throw new Error(
        `@UsageLimit('${feature}') requires an authenticated principal. ` +
          'Remove @Public() or meter via UsageLimitsService after identifying the subject.',
      );
    }

    await this.usageLimits.consume({ userId: principal.id }, feature);
    return true;
  }
}
