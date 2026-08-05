import { Inject, Injectable, Logger } from '@nestjs/common';
import { APIError } from 'better-auth';
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
 * Namespaces rate-limit counters, which Better Auth keys as `<ip>|<path>` with
 * no prefix of its own (`createRateLimitKey` in `@better-auth/core`).
 *
 * Not cosmetic, and not only for keyspace hygiene. Before this adapter had an
 * `increment`, the limiter ran on the library's `legacyConsume` path, which
 * stores a *JSON object* at that bare key. `INCR` against a JSON string is a
 * Redis error, and a fail-closed counter converts that error into a refused
 * sign-in — so reusing the same keys would make deploying this change 503 every
 * credential request until the stale keys expired, which at the default
 * `AUTH_STRICT_RATE_LIMIT_WINDOW_SECONDS` is five minutes. Writing the new
 * counters to their own namespace lets the old ones simply age out unread.
 */
const RATE_LIMIT_PREFIX = 'auth:ratelimit:';

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

  /**
   * Atomic counter consumption for the rate limiter — and the one method here
   * that deliberately lets a Redis failure reach the caller.
   *
   * Both properties rest on a single fact: **`increment` is read only by the
   * rate limiter.** Verified in better-auth 1.6.25, where
   * `getRateLimitStorage` builds its `consume` only `if
   * (secondaryStorage?.increment)`, and `onRequestRateLimit` returns
   * immediately after calling `consume` — so once this method exists the
   * limiter never consults `get`/`set` again, and nothing else in the library
   * calls it. `auth.factory.ts` asserts that path is the one actually taken;
   * see the note there.
   *
   * 1. **It fails closed.** No try/catch, unlike every other method in this
   *    class. To any caller that reads a missing counter as zero, a counter
   *    absent because Redis is unreachable is indistinguishable from one absent
   *    because nobody has attempted yet — so swallowing the error would admit
   *    every credential attempt unmetered during precisely the incident when
   *    someone is most likely to be probing. Sessions fail open because
   *    Postgres is authoritative behind them; counters have nothing behind
   *    them, so they must fail closed. **The asymmetry with `get`/`set`/`delete`
   *    above is the design, not an oversight — collapsing the two postures into
   *    one reintroduces an unmetered credential surface.**
   *
   * 2. **It is atomic.** Without this method the library falls back to
   *    `legacyConsume`, whose own comment reads: "Under concurrency this is
   *    best-effort: simultaneous requests can each pass the check before either
   *    write lands." `INCR` returns the post-increment count in one round trip,
   *    which is what makes the configured ceiling the actual ceiling.
   */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    const counter = `${RATE_LIMIT_PREFIX}${key}`;

    try {
      const count = await this.redis.incr(counter);

      /**
       * Set on creation only. Refreshing the TTL on every attempt would let a
       * persistent caller hold its own window open indefinitely — the same trap
       * `AccountLockoutService` avoids for the same reason.
       */
      if (count === 1 && ttlSeconds > 0) {
        await this.redis.expire(counter, ttlSeconds);
      }

      return count;
    } catch (error: unknown) {
      this.logger.error({
        msg: 'Rate limiter storage unavailable; refusing the request',
        requestId: RequestContext.getRequestId(),
        reason: error instanceof Error ? error.message : String(error),
      });

      /**
       * Rethrown as an `APIError` rather than left as a raw ioredis error so the
       * caller is told this is a temporary service condition. A bare throw
       * reaches Better Auth's `onError` and becomes a generic `500`, which reads
       * to a client as "this request was wrong" rather than "try again shortly"
       * — and on a credential endpoint, an ambiguous failure invites a retry
       * loop against the very dependency that is already down.
       */
      throw new APIError('SERVICE_UNAVAILABLE', {
        code: 'RATE_LIMITER_UNAVAILABLE',
        message:
          'Sign-in is temporarily unavailable. Please try again in a moment.',
      });
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
