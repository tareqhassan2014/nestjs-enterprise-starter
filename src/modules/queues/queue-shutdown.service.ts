import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';

import { QUEUE_NAMES } from '@config/queues.config';
import { shutdownConfig } from '@config/shutdown.config';

const POLL_INTERVAL_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounds BullMQ's worker drain to `SHUTDOWN_DRAIN_MS` (design.md decision
 * 6). `@nestjs/bullmq` already closes every `@Processor` worker on shutdown,
 * but its own hook awaits `worker.close()` with no timeout — and Nest gives
 * no ordering guarantee across modules.
 *
 * This polls until every queue is idle, or until `SHUTDOWN_DRAIN_MS`, then
 * force-disconnects each queue's Redis client so in-flight closes cannot hang
 * the process.
 */
@Injectable()
export class QueueShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueShutdownService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue,
    @InjectQueue(QUEUE_NAMES.WEBHOOKS_OUTBOUND)
    private readonly webhookQueue: Queue,
    @InjectQueue(QUEUE_NAMES.USAGE_ROLLUPS)
    private readonly rollupQueue: Queue,
    @Inject(shutdownConfig.KEY)
    private readonly config: ConfigType<typeof shutdownConfig>,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    const queues = [this.emailQueue, this.webhookQueue, this.rollupQueue];
    const deadline = Date.now() + this.config.drainMs;

    try {
      while (Date.now() < deadline) {
        const active = await this.activeJobCount(queues);
        if (active === 0) {
          return;
        }
        await delay(POLL_INTERVAL_MS);
      }

      const remaining = await this.activeJobCount(queues).catch(() => 0);
      if (remaining > 0) {
        this.logger.warn(
          `${remaining} job(s) still active after the ${this.config.drainMs}ms drain window; force-disconnecting BullMQ queue clients.`,
        );
      }
    } catch (error) {
      // BullMQ / Nest may already have closed Redis while we were draining —
      // especially in e2e `app.close()`. Treat that as "drain finished".
      this.logger.debug({
        msg: 'Queue drain interrupted because Redis was already closed',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await Promise.all(
      queues.map((queue) => queue.disconnect().catch(() => undefined)),
    );
  }

  private async activeJobCount(queues: Queue[]): Promise<number> {
    const counts = await Promise.all(
      queues.map((queue) => queue.getActiveCount().catch(() => 0)),
    );
    return counts.reduce((total, count) => total + count, 0);
  }
}
