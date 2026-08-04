import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { seconds, ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

import { throttleConfig } from '@config/throttle.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import { AppThrottlerGuard } from './app-throttler.guard';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Global Nest request throttling (burst + per-minute) on the shared Redis
 * client. Import **after** `AuthorizationModule` so Auth → Permissions →
 * Throttle order holds.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT, throttleConfig.KEY],
      useFactory: (
        redis: Redis,
        config: ConfigType<typeof throttleConfig>,
      ) => ({
        throttlers: [
          {
            name: 'burst',
            ttl: seconds(config.burst.windowSeconds),
            limit: config.burst.max,
          },
          {
            name: 'minute',
            ttl: seconds(config.minute.windowSeconds),
            limit: config.minute.max,
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class ThrottlingModule {}
