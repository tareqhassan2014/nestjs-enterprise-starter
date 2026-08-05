import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed throttle counters on the shared client.
 *
 * Keys: `throttle:{name}:{key}` and `throttle:{name}:block:{key}`, where `key`
 * comes from `AppThrottlerGuard.generateKey` and carries a policy segment —
 * `throttle:burst:strict:user:123`, say.
 *
 * **Both keys derive from that one argument, which is load-bearing.** The
 * `blockPttl > 0` short-circuit below returns `isBlocked` regardless of which
 * ceiling is asking, so if the incoming key did not distinguish policy, a block
 * written when a caller exceeded the strict account ceiling would deny every
 * other Nest route too. Scoping happens in `generateKey`; this class inherits it
 * for free. Anything that builds a key here from something other than `key`
 * would need to reapply that scoping itself.
 *
 * Failures propagate so the guard can fail closed rather than admit unmetered
 * traffic — the opposite of session-cache behaviour on the same client.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:${throttlerName}:block:${key}`;

    try {
      const blockPttl = await this.redis.pttl(blockKey);

      if (blockPttl > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: Math.ceil(blockPttl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockPttl / 1000),
        };
      }

      const hits = await this.redis.incr(hitsKey);
      let hitsPttl = await this.redis.pttl(hitsKey);

      if (hits === 1 || hitsPttl < 0) {
        await this.redis.pexpire(hitsKey, ttl);
        hitsPttl = ttl;
      }

      const timeToExpire = Math.max(1, Math.ceil(hitsPttl / 1000));

      if (hits > limit) {
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
        return {
          totalHits: hits,
          timeToExpire,
          isBlocked: true,
          timeToBlockExpire: Math.max(1, Math.ceil(blockDuration / 1000)),
        };
      }

      return {
        totalHits: hits,
        timeToExpire,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (error) {
      this.logger.warn(
        `Throttle storage failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
