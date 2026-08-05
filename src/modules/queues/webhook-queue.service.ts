import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { QUEUE_NAMES } from '@config/queues.config';

/** Provider-neutral outbound webhook attempt: URL, signed body, and headers. */
export interface WebhookJobPayload {
  url: string;
  /** Already-serializable payload; `WebhookProcessor` sends it as JSON. */
  body: unknown;
  /** e.g. a signature header the receiver verifies. Never logged verbatim. */
  headers?: Record<string, string>;
}

/**
 * Enqueues an at-least-once outbound webhook delivery attempt. Retries and
 * backoff are configured on the queue (`QueuesModule`); failures beyond the
 * last attempt land in BullMQ's failed set for visibility — there is no
 * generic webhook admin UI in v1 (see design.md decision 1).
 */
@Injectable()
export class WebhookQueueService {
  constructor(
    @InjectQueue(QUEUE_NAMES.WEBHOOKS_OUTBOUND)
    private readonly queue: Queue<WebhookJobPayload>,
  ) {}

  async enqueueOutboundWebhook(payload: WebhookJobPayload): Promise<void> {
    await this.queue.add('deliver', payload);
  }
}
