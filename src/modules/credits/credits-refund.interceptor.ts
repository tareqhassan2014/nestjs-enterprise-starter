import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import type { Request } from 'express';
import { catchError, from, type Observable, switchMap, throwError } from 'rxjs';

import { CreditCompensationQueueService } from '@modules/queues/credit-compensation-queue.service';

import {
  CREDITS_SPEND_REQUEST_KEY,
  type CreditsSpendMarker,
} from './credits.guard';
import { CreditService } from './credit.service';

/**
 * When CreditsGuard spent before the handler and the handler throws, refund
 * with the linked idempotency key so a client retry can spend again.
 *
 * Inline first, queued on failure. The inline attempt is the fast path and usually
 * succeeds, keeping the wallet correct within the request. But its failure is
 * *correlated* with the handler's — the same database or cache fault tends to break
 * both — so the case where compensation matters most was the case most likely to be
 * dropped. A failed inline refund is therefore handed to a durable queue rather
 * than left as a log line, with the caller already charged for work that did not
 * happen.
 */
@Injectable()
export class CreditsRefundInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CreditsRefundInterceptor.name);

  constructor(
    private readonly credits: CreditService,
    @Optional()
    private readonly compensations?: CreditCompensationQueueService,
  ) {}

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
        msg: 'Inline credit refund failed after handler failure; queueing retry',
        subject: marker.subject,
        feature: marker.feature,
        refundIdempotencyKey: marker.refundIdempotencyKey,
        error:
          refundError instanceof Error
            ? refundError.message
            : 'unknown_refund_error',
      });

      await this.queueCompensation(marker);
    }
  }

  /**
   * Hands the refund obligation to the durable queue.
   *
   * The same `refundIdempotencyKey` goes with it, so if the inline attempt had in
   * fact applied the refund before failing to report, the retry replays onto the
   * existing ledger entry as a no-op rather than refunding twice.
   *
   * If the enqueue *also* fails — Redis down alongside Postgres — this logs at
   * `error` and stops. There is no third store to fall back to, so that residual is
   * real and bounded by the log line; saying so beats implying the problem is fully
   * solved. Never rethrows: the caller must still see the handler's own error, not a
   * compensation failure.
   */
  private async queueCompensation(marker: CreditsSpendMarker): Promise<void> {
    if (!this.compensations) {
      this.logger.error({
        msg: 'No compensation queue available; credit refund obligation is unrecorded',
        subject: marker.subject,
        refundIdempotencyKey: marker.refundIdempotencyKey,
      });
      return;
    }

    try {
      await this.compensations.enqueueRefund({
        subject: marker.subject,
        amount: marker.amount,
        idempotencyKey: marker.refundIdempotencyKey,
        feature: marker.feature,
        reason: 'handler_failure_compensation_retry',
      });
    } catch (queueError) {
      this.logger.error({
        msg: 'Could not queue credit refund retry; obligation is unrecorded',
        subject: marker.subject,
        feature: marker.feature,
        refundIdempotencyKey: marker.refundIdempotencyKey,
        error:
          queueError instanceof Error
            ? queueError.message
            : 'unknown_queue_error',
      });
    }
  }
}
