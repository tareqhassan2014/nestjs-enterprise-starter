import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { QUEUE_NAMES, queuesConfig } from '@config/queues.config';
import { redisConfig } from '@config/redis.config';

import { CreditCompensationProcessor } from './credit-compensation.processor';
import { CreditCompensationQueueService } from './credit-compensation-queue.service';
import { EmailProcessor } from './email.processor';
import { EmailQueueService } from './email-queue.service';
import { LowBalanceEmailListener } from './low-balance-email.listener';
import { QueueShutdownService } from './queue-shutdown.service';
import { UsageRollupProcessor } from './usage-rollup.processor';
import { UsageRollupQueueService } from './usage-rollup-queue.service';
import { WebhookProcessor } from './webhook.processor';
import { WebhookQueueService } from './webhook-queue.service';

/**
 * Named queues for `email`, `webhooks.outbound`, `usage.rollups`, and
 * `credits.compensations` (design
 * .md decision 1), each isolated from throttle/usage/session Redis keys by
 * `BULLMQ_PREFIX`.
 *
 * Connection options use a dedicated Redis URL config (not `REDIS_CLIENT`):
 * that shared client fails fast (`enableOfflineQueue: false`, capped retries)
 * so throttle/usage checks fail closed quickly — the opposite of what BullMQ's
 * blocking commands need. `maxRetriesPerRequest: null` is BullMQ's documented
 * requirement for its blocking connection.
 *
 * `@Global()` so enqueue services are injectable anywhere without every
 * consumer importing this module.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY, queuesConfig.KEY],
      useFactory: (
        redis: ConfigType<typeof redisConfig>,
        config: ConfigType<typeof queuesConfig>,
      ) => ({
        connection: {
          url: redis.url,
          maxRetriesPerRequest: null,
        },
        prefix: config.prefix,
        defaultJobOptions: {
          attempts: config.defaultAttempts,
          backoff: { type: 'exponential' as const, delay: config.backoffMs },
          removeOnComplete: 500,
          removeOnFail: 1000,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.WEBHOOKS_OUTBOUND },
      { name: QUEUE_NAMES.USAGE_ROLLUPS },
      { name: QUEUE_NAMES.CREDIT_COMPENSATIONS },
    ),
  ],
  providers: [
    EmailProcessor,
    WebhookProcessor,
    UsageRollupProcessor,
    CreditCompensationProcessor,
    EmailQueueService,
    WebhookQueueService,
    UsageRollupQueueService,
    CreditCompensationQueueService,
    QueueShutdownService,
    LowBalanceEmailListener,
  ],
  exports: [
    EmailQueueService,
    WebhookQueueService,
    UsageRollupQueueService,
    CreditCompensationQueueService,
  ],
})
export class QueuesModule {}
