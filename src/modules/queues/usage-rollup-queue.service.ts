import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';

import { QUEUE_NAMES, queuesConfig } from '@config/queues.config';

export interface UsageRollupJobPayload {
  triggeredAt: string;
}

/**
 * Enqueues a rollup tick on an interval when `USAGE_ROLLUP_INTERVAL_MS` is
 * set (> 0). A value of 0 (the default) disables the scheduler entirely —
 * rollups are then purely admin/CLI-triggered via `enqueueRollup()`. Either
 * way this never touches the synchronous `UsageLimitsService.consume` path;
 * see `UsageRollupProcessor`.
 */
@Injectable()
export class UsageRollupQueueService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(UsageRollupQueueService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectQueue(QUEUE_NAMES.USAGE_ROLLUPS)
    private readonly queue: Queue<UsageRollupJobPayload>,
    @Inject(queuesConfig.KEY)
    private readonly config: ConfigType<typeof queuesConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.usageRollupIntervalMs <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      this.enqueueRollup().catch((error: unknown) => {
        this.logger.warn(
          `Failed to enqueue scheduled usage rollup: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, this.config.usageRollupIntervalMs);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async enqueueRollup(): Promise<void> {
    await this.queue.add('rollup', { triggeredAt: new Date().toISOString() });
  }
}
