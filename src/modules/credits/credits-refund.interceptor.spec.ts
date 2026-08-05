import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';

import { userSubject } from '@modules/organizations/billing-subject';
import { CreditCompensationProcessor } from '@modules/queues/credit-compensation.processor';

import { CREDITS_SPEND_REQUEST_KEY } from './credits.guard';
import { CreditsRefundInterceptor } from './credits-refund.interceptor';

const MARKER = {
  subject: userSubject('u1'),
  feature: 'demo.paid',
  amount: 7,
  spendIdempotencyKey: 'spend:req-1:demo.paid',
  refundIdempotencyKey: 'refund:req-1:demo.paid',
};

/** An HTTP context whose request already carries a pre-handler spend marker. */
function contextWithMarker(): ExecutionContext {
  const request = { [CREDITS_SPEND_REQUEST_KEY]: MARKER };

  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** A handler that always fails, which is what triggers compensation. */
const failingHandler: CallHandler = {
  handle: () => throwError(() => new Error('handler exploded')),
};

describe('CreditsRefundInterceptor compensation', () => {
  it('refunds inline and does not queue when the inline attempt succeeds', async () => {
    const credits = { refund: jest.fn().mockResolvedValue(undefined) };
    const compensations = { enqueueRefund: jest.fn() };

    const interceptor = new CreditsRefundInterceptor(
      credits as never,
      compensations as never,
    );

    await expect(
      firstValueFrom(
        interceptor.intercept(contextWithMarker(), failingHandler),
      ),
    ).rejects.toThrow('handler exploded');

    expect(credits.refund).toHaveBeenCalledTimes(1);
    // The fast path stays the only path when it works.
    expect(compensations.enqueueRefund).not.toHaveBeenCalled();
  });

  it('queues a durable refund with the same key when the inline attempt fails', async () => {
    const credits = {
      refund: jest.fn().mockRejectedValue(new Error('database unreachable')),
    };
    const compensations = {
      enqueueRefund: jest.fn().mockResolvedValue(undefined),
    };

    const interceptor = new CreditsRefundInterceptor(
      credits as never,
      compensations as never,
    );

    await expect(
      firstValueFrom(
        interceptor.intercept(contextWithMarker(), failingHandler),
      ),
    ).rejects.toThrow('handler exploded');

    /**
     * The same `refundIdempotencyKey` the inline attempt used. That is what makes
     * the retry safe: if the inline refund had in fact landed before failing to
     * report, the queued replay hits the existing ledger entry as a no-op.
     */
    expect(compensations.enqueueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: MARKER.subject,
        amount: MARKER.amount,
        feature: MARKER.feature,
        idempotencyKey: MARKER.refundIdempotencyKey,
      }),
    );
  });

  it("surfaces the handler's error even when the enqueue also fails", async () => {
    const credits = {
      refund: jest.fn().mockRejectedValue(new Error('database unreachable')),
    };
    const compensations = {
      enqueueRefund: jest
        .fn()
        .mockRejectedValue(new Error('redis unreachable')),
    };

    const interceptor = new CreditsRefundInterceptor(
      credits as never,
      compensations as never,
    );

    /**
     * The caller must see what actually broke their request, not a compensation
     * failure. This is also the documented residual: with both stores down the
     * obligation survives only in the log.
     */
    await expect(
      firstValueFrom(
        interceptor.intercept(contextWithMarker(), failingHandler),
      ),
    ).rejects.toThrow('handler exploded');
  });

  it('does nothing when no spend happened', async () => {
    const credits = { refund: jest.fn() };
    const compensations = { enqueueRefund: jest.fn() };

    const interceptor = new CreditsRefundInterceptor(
      credits as never,
      compensations as never,
    );

    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;

    await expect(
      firstValueFrom(interceptor.intercept(context, failingHandler)),
    ).rejects.toThrow('handler exploded');

    expect(credits.refund).not.toHaveBeenCalled();
    expect(compensations.enqueueRefund).not.toHaveBeenCalled();
  });
});

describe('CreditCompensationProcessor', () => {
  it('replays the refund through CreditService with the supplied key', async () => {
    const credits = { refund: jest.fn().mockResolvedValue(undefined) };
    const processor = new CreditCompensationProcessor(credits as never);

    await processor.process({
      data: {
        subject: MARKER.subject,
        amount: MARKER.amount,
        idempotencyKey: MARKER.refundIdempotencyKey,
        feature: MARKER.feature,
        reason: 'handler_failure_compensation_retry',
      },
      attemptsMade: 0,
    } as never);

    /**
     * Through `CreditService`, not the wallet directly, so the ledger, balance
     * update, and row lock behave exactly as they do inline — and the shared key is
     * what makes a duplicate replay a no-op rather than a second refund.
     */
    expect(credits.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: MARKER.subject,
        amount: MARKER.amount,
        idempotencyKey: MARKER.refundIdempotencyKey,
        feature: MARKER.feature,
      }),
    );
  });

  it('rethrows so BullMQ retries a failed replay', async () => {
    const credits = {
      refund: jest.fn().mockRejectedValue(new Error('still unreachable')),
    };
    const processor = new CreditCompensationProcessor(credits as never);

    await expect(
      processor.process({
        data: {
          subject: MARKER.subject,
          amount: MARKER.amount,
          idempotencyKey: MARKER.refundIdempotencyKey,
          reason: 'retry',
        },
        attemptsMade: 1,
      } as never),
    ).rejects.toThrow('still unreachable');
  });
});
