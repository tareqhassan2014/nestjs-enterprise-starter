import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from '@config/queues.config';

import type { WebhookJobPayload } from './webhook-queue.service';

/** See `EmailProcessor` for why concurrency is a fixed constant here. */
const WEBHOOK_WORKER_CONCURRENCY = 5;

/** Bounds a single delivery attempt; retries happen at the queue level. */
const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

/**
 * POSTs a queued outbound webhook. A non-2xx response or a network/timeout
 * failure rethrows so BullMQ retries with the configured exponential
 * backoff; after the final attempt the job lands in the failed set with a
 * structured log line for visibility (see design.md decision 1).
 */
@Processor(QUEUE_NAMES.WEBHOOKS_OUTBOUND, {
  concurrency: WEBHOOK_WORKER_CONCURRENCY,
})
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  async process(job: Job<WebhookJobPayload>): Promise<void> {
    const { url, body, headers } = job.data;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      WEBHOOK_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Webhook POST to ${url} responded with status ${response.status}`,
        );
      }
    } catch (error) {
      this.logger.warn({
        msg: 'Outbound webhook attempt failed',
        jobId: job.id,
        url,
        attempt: job.attemptsMade + 1,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
