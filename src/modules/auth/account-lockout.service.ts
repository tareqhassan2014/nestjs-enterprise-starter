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
 * What Redis holds per account. Stored as JSON rather than a bare integer
 * because the two fields have to move together: a counter alone cannot say when
 * the lock it implies actually ends.
 */
interface LockoutRecord {
  failures: number;
  /** Epoch millis the lock expires. `0` when the threshold is not yet crossed. */
  lockedUntil: number;
}

const EMPTY_RECORD: LockoutRecord = { failures: 0, lockedUntil: 0 };

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
 * - **Self-healing.** The record is a Redis key with a TTL. It expires on its
 *   own, so there is no sticky lock and no administrative unlock step. An
 *   attacker can slow a targeted user down during an active attack; they cannot
 *   durably deny that user their account, which is what a permanent lock would
 *   hand them.
 * - **Honest about the wait.** The record carries an explicit `lockedUntil`
 *   rather than leaving the unlock moment implied by a key's TTL. When those two
 *   diverge, the advertised `Retry-After` becomes a number that has nothing to do
 *   with when the caller is let back in — and this one is mirrored into the
 *   standard header for clients to act on, so a wrong value is worse than none.
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
    return this.decide(await this.read(identifier));
  }

  /**
   * Records a failure and reports the resulting backoff.
   *
   * Read-modify-write rather than `INCR`, because the delay is derived from the
   * failure count and has to be stamped into the same record. Not atomic, and it
   * does not need to be: a lost update under concurrency costs one increment
   * against an attacker's own counter, which is a rounding error next to the
   * threshold. Contrast the per-address limiter, where the count *is* the
   * enforcement and atomicity is load-bearing.
   */
  async recordFailure(identifier: string): Promise<LockoutDecision> {
    const { threshold, windowSeconds } = this.config.lockout;

    const current = await this.read(identifier);
    const failures = current.failures + 1;

    /**
     * The delay is stamped at the moment of failure, so `lockedUntil` is the one
     * answer to "when may I try again?" — rather than a figure computed on read
     * that no clock is ever compared against.
     */
    const delay = failures < threshold ? 0 : this.delayFor(failures);

    const record: LockoutRecord = {
      failures,
      lockedUntil: delay === 0 ? 0 : Date.now() + delay * 1000,
    };

    /**
     * The key must outlive the lock it describes, or the record would vanish
     * mid-lock and the next attempt would start from zero failures — handing an
     * attacker a counter reset for free. Hence `max(window, delay)`.
     */
    const ttlSeconds = Math.max(windowSeconds, delay);

    /**
     * `EX` on every write, unlike the old bare counter which set its TTL only on
     * creation. That distinction mattered when the TTL *was* the lock: refreshing
     * it let an attacker hold the window open by knocking. It no longer can,
     * because the lock is now `lockedUntil` and only a genuine credential failure
     * moves it — a rejection issued by the lock itself is never counted (see the
     * `after` hook in `auth.factory.ts`), so knocking cannot extend anything.
     * What the refresh buys instead is that the record survives its own lock.
     */
    await this.redis.set(
      this.key(identifier),
      JSON.stringify(record),
      'EX',
      ttlSeconds,
    );

    return this.decide(record);
  }

  /**
   * A successful sign-in clears the account's history.
   *
   * Deletes the key, so both `failures` and `lockedUntil` go together — clearing
   * the count while leaving a stamped lock behind would refuse a user who just
   * proved they own the account.
   */
  async clear(identifier: string): Promise<void> {
    try {
      await this.redis.del(this.key(identifier));
    } catch (error: unknown) {
      // The record expires on its own, so a failed reset costs the user a
      // shorter-than-expected window, not access.
      this.logger.warn({
        msg: 'Could not clear lockout record',
        requestId: RequestContext.getRequestId(),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reads the record, treating anything unparseable as absent.
   *
   * Tolerant of a stale value in the old bare-counter format: a deploy leaves
   * those behind, and the alternative to ignoring them is throwing on a key an
   * attacker can create at will.
   */
  private async read(identifier: string): Promise<LockoutRecord> {
    const raw = await this.redis.get(this.key(identifier));

    if (raw === null) {
      return EMPTY_RECORD;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<LockoutRecord>;

      if (typeof parsed?.failures !== 'number') {
        return EMPTY_RECORD;
      }

      return {
        failures: parsed.failures,
        lockedUntil:
          typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
      };
    } catch {
      return EMPTY_RECORD;
    }
  }

  /**
   * Exponential backoff past the threshold, capped.
   *
   * The first failure at the threshold waits `baseDelaySeconds`, then doubles per
   * additional failure, never above `maxDelaySeconds`.
   */
  private delayFor(failures: number): number {
    const { threshold, baseDelaySeconds, maxDelaySeconds } =
      this.config.lockout;

    const excess = failures - threshold;

    return Math.min(baseDelaySeconds * 2 ** excess, maxDelaySeconds);
  }

  /**
   * Locked while the stamped moment is still in the future, and the reported wait
   * is the remainder — so a caller who waits exactly what they were told is let
   * through rather than refused again.
   */
  private decide(record: LockoutRecord): LockoutDecision {
    const remainingMs = record.lockedUntil - Date.now();

    if (remainingMs <= 0) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    return {
      locked: true,
      // Rounded up: rounding down would advertise a wait that is still short by
      // a fraction of a second, which is the bug this whole field exists to fix.
      retryAfterSeconds: Math.ceil(remainingMs / 1000),
    };
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
