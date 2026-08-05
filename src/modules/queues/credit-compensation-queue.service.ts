import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { QUEUE_NAMES } from '@config/queues.config';
import type { BillingSubject } from '@modules/organizations/billing-subject';

export interface CreditCompensationJobPayload {
  subject: BillingSubject;
  amount: number;
  /**
   * The *same* key the inline attempt used. What makes the retry safe: if the
   * inline refund actually landed before failing to report, this replays onto the
   * existing ledger entry as a no-op rather than refunding twice.
   */
  idempotencyKey: string;
  feature?: string;
  /** Carried through for the ledger entry, so the trail says why. */
  reason: string;
}

/**
 * Durable retry for a compensating refund the request path could not complete.
 *
 * Exists because the inline compensation in `CreditsRefundInterceptor` fails for
 * correlated reasons — whatever broke the handler (a database or cache fault) is
 * the likeliest thing to break the refund immediately after. That made the case
 * where compensation matters most the case where it was most likely to be dropped
 * with only a log line, leaving the caller charged for work that never happened.
 */
@Injectable()
export class CreditCompensationQueueService {
  constructor(
    @InjectQueue(QUEUE_NAMES.CREDIT_COMPENSATIONS)
    private readonly queue: Queue<CreditCompensationJobPayload>,
  ) {}

  async enqueueRefund(payload: CreditCompensationJobPayload): Promise<void> {
    await this.queue.add('refund', payload, {
      /** Deduplicates identical enqueues; the ledger key is the real guard. */
      jobId: `credit-refund:${payload.idempotencyKey}`,
    });
  }
}
