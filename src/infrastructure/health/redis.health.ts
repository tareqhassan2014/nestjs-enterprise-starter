import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import { redisConfig } from '@config/redis.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

/**
 * Terminus ships no first-class ioredis check, so this is the readiness probe's
 * Redis leg. Built on Terminus 11's `HealthIndicatorService` rather than by
 * subclassing `HealthIndicator`, which that release replaced.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(redisConfig.KEY)
    private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);

    try {
      const reply = await withTimeout(
        this.redis.ping(),
        this.config.healthTimeoutMs,
      );

      if (reply !== 'PONG') {
        return indicator.down({ message: 'Unexpected reply to PING' });
      }

      return indicator.up();
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'Redis unreachable',
      });
    }
  }
}

/**
 * A dependency that accepts the connection but never answers must fail the
 * probe, not hang it.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Health check timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
