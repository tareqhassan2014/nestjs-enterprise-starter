import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { RequestContext } from '@common/context/request-context';
import { authConfig } from '@config/auth.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

export interface LockoutDecision {
  locked: boolean;
  /** Seconds the caller must wait. Zero when not locked. */
  retryAfterSeconds: number;
}

/**
 * Per-account failure counting, separate from the per-address rate limit.
 *
 * An address-keyed limiter does nothing about a distributed attack on one
 * account: a thousand hosts each making four attempts trips no per-address rule
 * while making four thousand guesses at one password. This counts by *account*
 * instead.
 *
 * Three properties matter, and each is a deliberate choice:
 *
 * - **Self-healing.** The counter is a Redis key with a TTL. It expires on its
 *   own, so there is no sticky lock and no administrative unlock step. An
 *   attacker can slow a targeted user down during an active attack; they cannot
 *   durably deny that user their account, which is what a permanent lock would
 *   hand them.
 * - **Non-disclosing.** Counters are consumed for identifiers that do not exist,
 *   so the limiter cannot be used to enumerate accounts. Without that, the
 *   careful wording of the error messages would be undone by the rate limit.
 * - **Hashed keys.** Keys hold `sha256(normalised identifier)`, so raw addresses
 *   are not sitting in the Redis keyspace, in `MONITOR` output, or in a dump.
 *   This is disclosure hygiene, not protection against someone who can already
 *   run commands against Redis.
 */
@Injectable()
export class AccountLockoutService {
  private readonly logger = new Logger(AccountLockoutService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  /**
   * Whether this identifier is currently in a backoff window.
   *
   * Throws on a storage failure rather than returning "not locked" — see
   * `AuthRateLimitGuard`'s note on failing closed. Callers decide what that
   * means for their route.
   */
  async check(identifier: string): Promise<LockoutDecision> {
    const failures = await this.failureCount(identifier);

    return this.decide(failures);
  }

  /** Records a failure and reports the resulting backoff. */
  async recordFailure(identifier: string): Promise<LockoutDecision> {
    const key = this.key(identifier);
    const { windowSeconds } = this.config.lockout;

    const failures = await this.redis.incr(key);

    /**
     * Set the TTL only when the counter is created. Refreshing it on every
     * attempt would let an attacker hold the window open indefinitely, which
     * would turn a self-healing delay back into a permanent lock.
     */
    if (failures === 1) {
      await this.redis.expire(key, windowSeconds);
    }

    return this.decide(failures);
  }

  /** A successful sign-in clears the account's history. */
  async clear(identifier: string): Promise<void> {
    try {
      await this.redis.del(this.key(identifier));
    } catch (error: unknown) {
      // The counter expires on its own, so a failed reset costs the user a
      // shorter-than-expected window, not access.
      this.logger.warn({
        msg: 'Could not clear lockout counter',
        requestId: RequestContext.getRequestId(),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async failureCount(identifier: string): Promise<number> {
    const raw = await this.redis.get(this.key(identifier));

    return raw === null ? 0 : Number.parseInt(raw, 10);
  }

  /**
   * Exponential backoff past the threshold, capped.
   *
   * The first failure over the threshold waits `baseDelaySeconds`, then double
   * each time, never above `maxDelaySeconds`.
   */
  private decide(failures: number): LockoutDecision {
    const { threshold, baseDelaySeconds, maxDelaySeconds } =
      this.config.lockout;

    if (failures < threshold) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    const excess = failures - threshold;
    const delay = Math.min(baseDelaySeconds * 2 ** excess, maxDelaySeconds);

    return { locked: true, retryAfterSeconds: delay };
  }

  /**
   * `sha256` of the lower-cased, trimmed identifier, so case variants of one
   * address share a counter and no raw address reaches the keyspace.
   */
  private key(identifier: string): string {
    const digest = createHash('sha256')
      .update(identifier.trim().toLowerCase())
      .digest('hex');

    return `auth:lockout:${digest}`;
  }
}
