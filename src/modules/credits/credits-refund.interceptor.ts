import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { catchError, from, type Observable, switchMap, throwError } from 'rxjs';

import {
  CREDITS_SPEND_REQUEST_KEY,
  type CreditsSpendMarker,
} from './credits.guard';
import { CreditService } from './credit.service';

/**
 * When CreditsGuard spent before the handler and the handler throws, refund
 * with the linked idempotency key so a client retry can spend again.
 */
@Injectable()
export class CreditsRefundInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CreditsRefundInterceptor.name);

  constructor(private readonly credits: CreditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();

    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          from(this.refundIfNeeded(request, error)).pipe(
            switchMap(() => throwError(() => error)),
          ),
        ),
      );
  }

  private async refundIfNeeded(
    request: Request,
    error: unknown,
  ): Promise<void> {
    const marker = (
      request as Request & {
        [CREDITS_SPEND_REQUEST_KEY]?: CreditsSpendMarker;
      }
    )[CREDITS_SPEND_REQUEST_KEY];

    if (!marker) {
      return;
    }

    try {
      await this.credits.refund({
        subject: marker.subject,
        amount: marker.amount,
        idempotencyKey: marker.refundIdempotencyKey,
        feature: marker.feature,
        metadata: {
          reason: 'handler_failure_compensation',
          spendIdempotencyKey: marker.spendIdempotencyKey,
          error:
            error instanceof Error ? error.message : 'unknown_handler_error',
        },
      });
    } catch (refundError) {
      this.logger.error({
        msg: 'Failed to refund credits after handler failure',
        subject: marker.subject,
        feature: marker.feature,
        refundIdempotencyKey: marker.refundIdempotencyKey,
        error:
          refundError instanceof Error
            ? refundError.message
            : 'unknown_refund_error',
      });
    }
  }
}
