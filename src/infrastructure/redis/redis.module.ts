import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Redis } from 'ioredis';

import { redisConfig } from '@config/redis.config';

import { REDIS_CLIENT } from './redis.constants';

/**
 * A single shared Redis connection.
 *
 * `enableOfflineQueue: false` is deliberate: when Redis is down, commands must
 * fail fast so the readiness probe reports it, rather than queueing silently
 * until the probe times out. That setting also rules out `lazyConnect` — with
 * both, the very first command is rejected before a connection is ever
 * attempted, which would make readiness report a healthy Redis as down.
 *
 * The `error` listener is not optional: an ioredis client with no listener
 * turns a connection blip into an unhandled `error` event.
 *
 * Consumers on this client: Better Auth secondary storage (sessions + auth
 * rate limits), permission-cache version stamps, Nest request throttling, and
 * daily/weekly usage counters. Session cache fails open (Postgres fallback);
 * throttle and usage checks fail closed.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>): Redis => {
        const logger = new Logger('RedisClient');

        const client = new Redis(config.url, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: config.healthTimeoutMs,
          retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
        });

        client.on('error', (error: Error) => {
          logger.warn(`Redis connection error: ${error.message}`);
        });

        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') {
      return;
    }

    // `quit()` drains in-flight commands, but never resolves on a client that
    // failed to connect — `disconnect()` afterwards guarantees teardown.
    await this.redis.quit().catch(() => undefined);
    this.redis.disconnect();
  }
}
