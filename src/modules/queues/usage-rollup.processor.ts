import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { QUEUE_NAMES } from '@config/queues.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import type { UsageRollupJobPayload } from './usage-rollup-queue.service';

/** See `EmailProcessor` for why concurrency is a fixed constant here. */
const USAGE_ROLLUP_WORKER_CONCURRENCY = 1;

const USAGE_KEY_SCAN_PATTERN = 'usage:*';
const USAGE_KEY_SCAN_COUNT = 200;

/**
 * Skeleton aggregator: SCANs the `usage:*` keyspace and logs a summary.
 * Read-only — it never mutates or deletes a counter, so it cannot affect
 * `UsageLimitsService.consume`'s live admission decisions (see design.md
 * decision 1: "must not replace synchronous guard consume"). Forks that want
 * persisted snapshots write them from here into whatever table or warehouse
 * they choose; this starter only logs, deliberately.
 */
@Processor(QUEUE_NAMES.USAGE_ROLLUPS, {
  concurrency: USAGE_ROLLUP_WORKER_CONCURRENCY,
})
export class UsageRollupProcessor extends WorkerHost {
  private readonly logger = new Logger(UsageRollupProcessor.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async process(job: Job<UsageRollupJobPayload>): Promise<void> {
    let cursor = '0';
    let scanned = 0;

    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        USAGE_KEY_SCAN_PATTERN,
        'COUNT',
        USAGE_KEY_SCAN_COUNT,
      );
      cursor = next;
      scanned += keys.length;
    } while (cursor !== '0');

    this.logger.log({
      msg: 'Usage rollup tick',
      jobId: job.id,
      triggeredAt: job.data.triggeredAt,
      countersScanned: scanned,
    });
  }
}
