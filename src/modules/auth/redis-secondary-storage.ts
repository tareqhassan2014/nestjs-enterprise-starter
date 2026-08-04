import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BetterAuthOptions } from 'better-auth/types';
import type { Redis } from 'ioredis';

import { RequestContext } from '@common/context/request-context';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

/**
 * Derived from the option field rather than imported by name: the library does
 * not re-export this type from a stable public path, and deriving it means the
 * compiler checks this class against whatever `secondaryStorage` actually
 * requires at the installed version.
 */
type SecondaryStorage = NonNullable<BetterAuthOptions['secondaryStorage']>;

/**
 * Better Auth's `secondaryStorage` on the shared Redis client — a cache in front
 * of Postgres, never a second source of truth.
 *
 * That property does not come for free. With `secondaryStorage` configured,
 * Better Auth stores sessions in Redis *only* by default, and reads always go
 * there; an eviction would silently sign every user out. It is the
 * `storeSessionInDatabase: true` / `preserveSessionInDatabase: false` pair in
 * `auth.factory.ts` that makes a miss fall through to the database instead. See
 * design.md decision 3.
 *
 * Which is why every method here swallows its own errors and reports a MISS
 * rather than throwing: a miss is a path Better Auth handles by reading
 * Postgres, whereas a thrown error would surface as a failed request. This is
 * the one place in the codebase where swallowing an error is correct, and it is
 * only correct because an authoritative store sits behind it.
 *
 * The shared client runs with `enableOfflineQueue: false`, so commands reject
 * fast when Redis is down instead of queueing — which is what keeps this
 * degradation quick rather than a per-request stall.
 */
@Injectable()
export class RedisSecondaryStorage implements SecondaryStorage {
  private readonly logger = new Logger(RedisSecondaryStorage.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error: unknown) {
      this.degraded('get', error);
      return null;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    try {
      if (ttl !== undefined && ttl > 0) {
        await this.redis.set(key, value, 'EX', ttl);
      } else {
        await this.redis.set(key, value);
      }
    } catch (error: unknown) {
      // Losing a cache write is survivable: the database write is the one that
      // matters, and the next read falls through to it.
      this.degraded('set', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error: unknown) {
      // The database delete still happens, so a revoked session stays revoked
      // even if its cache entry lingers until its TTL.
      this.degraded('delete', error);
    }
  }

  private degraded(operation: string, error: unknown): void {
    this.logger.warn({
      msg: `Session cache ${operation} failed; falling back to the database`,
      requestId: RequestContext.getRequestId(),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
