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
import type { BillingSubject } from '@modules/organizations/billing-subject';
import { BillingSubjectResolver } from '@modules/organizations/billing-subject.resolver';

import { type CreditFeature, creditCost } from './credit-costs';
import { COSTS_CREDITS_KEY } from './credit.decorators';
import { CreditService } from './credit.service';

/** Request marker so the refund interceptor can compensate on handler failure. */
export const CREDITS_SPEND_REQUEST_KEY = 'creditsSpend';

export interface CreditsSpendMarker {
  subject: BillingSubject;
  feature: CreditFeature;
  amount: number;
  spendIdempotencyKey: string;
  refundIdempotencyKey: string;
}

/**
 * Stage six of the chain: debit catalogue credits after usage limits.
 *
 * No-op unless `@CostsCredits` is present. Consumes the AuthGuard principal.
 */
@Injectable()
export class CreditsGuard implements CanActivate {
  private readonly logger = new Logger(CreditsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly credits: CreditService,
    private readonly billingSubjects: BillingSubjectResolver,
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

    const feature = this.reflector.getAllAndOverride<CreditFeature | undefined>(
      COSTS_CREDITS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!feature) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const principal = this.principalOf(request);
    const subject = await this.billingSubjects.resolve(principal.id);
    const amount = creditCost(feature);
    const requestId = RequestContext.getRequestId() ?? 'unknown';
    const spendIdempotencyKey = `spend:${requestId}:${feature}`;
    const refundIdempotencyKey = `refund:${requestId}:${feature}`;

    try {
      await this.credits.spend({
        subject,
        amount,
        idempotencyKey: spendIdempotencyKey,
        feature,
      });
    } catch (error) {
      if (
        error instanceof ApiException &&
        error.code === ErrorCode.INSUFFICIENT_CREDITS
      ) {
        this.logger.warn({
          msg: 'Insufficient credits',
          requestId,
          subject,
          feature,
          amount,
        });
      }
      throw error;
    }

    const carrier = request as Request & {
      [CREDITS_SPEND_REQUEST_KEY]?: CreditsSpendMarker;
    };
    carrier[CREDITS_SPEND_REQUEST_KEY] = {
      subject,
      feature,
      amount,
      spendIdempotencyKey,
      refundIdempotencyKey,
    };

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
