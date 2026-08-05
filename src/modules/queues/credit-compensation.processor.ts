import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from '@config/queues.config';
import { CreditService } from '@modules/credits/credit.service';

import type { CreditCompensationJobPayload } from './credit-compensation-queue.service';

/** See `EmailProcessor` for why concurrency is a fixed constant here. */
const CREDIT_COMPENSATION_CONCURRENCY = 2;

/**
 * Replays a compensating refund that the request path could not complete.
 *
 * Goes through `CreditService.refund` rather than touching the wallet directly, so
 * the ledger, the balance update, and the row lock all behave exactly as they do
 * inline — `CreditService` stays the sole authority for balance mutations.
 *
 * The payload's `idempotencyKey` is the one the inline attempt used, so a refund
 * that actually landed before the process failed replays as a no-op. A throw here
 * rethrows to BullMQ for the configured exponential backoff; after the final
 * attempt the job lands in the failed set, which is where an operator has to look.
 */
@Processor(QUEUE_NAMES.CREDIT_COMPENSATIONS, {
  concurrency: CREDIT_COMPENSATION_CONCURRENCY,
})
export class CreditCompensationProcessor extends WorkerHost {
  private readonly logger = new Logger(CreditCompensationProcessor.name);

  constructor(private readonly credits: CreditService) {
    super();
  }

  async process(job: Job<CreditCompensationJobPayload>): Promise<void> {
    const { subject, amount, idempotencyKey, feature, reason } = job.data;

    await this.credits.refund({
      subject,
      amount,
      idempotencyKey,
      feature,
      metadata: { reason, viaQueue: true, attempt: job.attemptsMade + 1 },
    });

    this.logger.log({
      msg: 'Compensating credit refund applied from queue',
      subject,
      feature,
      idempotencyKey,
    });
  }
}
