import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { authConfig, type AuthConfig } from '@config/auth.config';
import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { redisConfig } from '@config/redis.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { AccountLockoutService } from '@modules/auth/account-lockout.service';

import { TEST_PASSWORD, createVerifiedUser, uniqueEmail } from './auth-helpers';
import { createTestApp } from './create-test-app';

/** Tight enough to trip quickly, loose enough to leave room to observe. */
const GENERAL_MAX = 40;
const STRICT_MAX = 4;
const LOCKOUT_THRESHOLD = 3;

/**
 * Integration test: requires the Compose stack.
 *
 * Builds the app with its own limits rather than the environment's, because the
 * shared test environment deliberately uses generous ones so that suites which
 * are not about throttling do not get throttled.
 */
describe('Auth rate limiting and account lockout (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let lockout: AccountLockoutService;
  let redis: {
    keys: (pattern: string) => Promise<string[]>;
    del: (...keys: string[]) => Promise<number>;
    get: (key: string) => Promise<string | null>;
    incr: (key: string) => Promise<number>;
  };

  const createdEmails: string[] = [];

  beforeAll(async () => {
    const tightened: AuthConfig = {
      ...authConfig(),
      rateLimit: {
        windowSeconds: 60,
        max: GENERAL_MAX,
        strictWindowSeconds: 60,
        strictMax: STRICT_MAX,
      },
      /**
       * `baseDelaySeconds: 1` because the escalation cases wait out real backoff
       * windows over HTTP — the only way to prove the delay grows in the request
       * flow rather than only in the decision function. At a base of 2 those waits
       * summed to roughly 25 seconds of a held Jest worker, which is wall-clock
       * this suite spends doing nothing and back-pressure on every suite sharing
       * the machine. A base of 1 halves it and still yields 1 → 2 → 4 against a cap
       * of 8, so both growth and the ceiling remain observable.
       */
      lockout: {
        threshold: LOCKOUT_THRESHOLD,
        baseDelaySeconds: 1,
        maxDelaySeconds: 8,
        windowSeconds: 30,
      },
    };

    /**
     * Also redirected to its own Redis logical database.
     *
     * Rate-limit counters are keyed `<ip>|<path>` with no prefix and no notion of
     * which app wrote them. Every e2e suite signs in from the same address, and
     * Jest runs them in parallel — so without isolation, requests made by other
     * suites (which run under the environment's deliberately generous limits)
     * increment the very counters this suite evaluates against a max of four, and
     * every request here returns `429` before reaching a handler.
     */
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(authConfig.KEY)
        .useValue(tightened)
        .overrideProvider(redisConfig.KEY)
        .useValue({ ...redisConfig(), url: `${redisConfig().url}/9` }),
    );

    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    lockout = app.get(AccountLockoutService);
    redis = app.get(REDIS_CLIENT);
  }, 60_000);

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    await app.close();
  });

  /**
   * Limits are shared state, so each case starts from a clean keyspace.
   *
   * The library stores rate-limit counters under a bare `<ip>|<path>` key with no
   * prefix (`createRateLimitKey` in `better-auth/dist/api/rate-limiter`), so
   * `*|/*` is what matches them. Getting this wrong is silent and confusing: the
   * limiter stays exhausted from an earlier case, every request returns `429`
   * before reaching the handler, and lockout assertions fail for a reason that
   * has nothing to do with lockout.
   */
  async function clearLimiterState(): Promise<void> {
    for (const pattern of ['auth:lockout:*', 'auth:ratelimit:*', '*|/*']) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  }

  /**
   * Clears only the per-address counters, leaving lockout records standing.
   *
   * This is what makes per-account lockout observable over HTTP at all. The two
   * mechanisms both guard `/sign-in/email`, and the per-address limiter is by far
   * the tighter of the two here (`STRICT_MAX` of 4 against a lockout threshold of
   * 3), so a test that simply keeps posting credentials hits `429 RATE_LIMITED`
   * after four attempts and never reaches the lockout behaviour it meant to
   * exercise. Dropping the address counters between attempts isolates the
   * account-keyed mechanism without weakening either one.
   *
   * Possible because limiter counters now carry their own `auth:ratelimit:`
   * namespace — under the library's bare `<ip>|<path>` keys there was no way to
   * clear one without matching the other.
   */
  async function clearAddressLimiter(): Promise<void> {
    const keys = await redis.keys('auth:ratelimit:*');

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /** Posts wrong credentials with the address limiter cleared first. */
  async function unmeteredSignIn(email: string) {
    await clearAddressLimiter();

    return signIn(email);
  }

  /** Drives the account to exactly its lockout threshold. */
  async function crossLockoutThreshold(email: string): Promise<void> {
    for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
      await unmeteredSignIn(email);
    }
  }

  beforeEach(clearLimiterState);

  const signIn = (email: string, password = 'wrong-password-entirely') =>
    request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .send({ email, password });

  async function attempt(email: string, times: number): Promise<number[]> {
    const statuses: number[] = [];

    for (let index = 0; index < times; index += 1) {
      statuses.push((await signIn(email)).status);
    }

    return statuses;
  }

  describe('credential endpoints are limited', () => {
    it('rejects further attempts with 429 once the strict limit is exceeded', async () => {
      const email = uniqueEmail('rl-strict');
      const statuses = await attempt(email, STRICT_MAX + 3);

      expect(statuses).toContain(429);
    });

    it('tells the client how long to wait', async () => {
      const email = uniqueEmail('rl-retry');
      await attempt(email, STRICT_MAX + 3);

      const limited = await signIn(email);

      expect(limited.status).toBe(429);

      const retryAfter =
        limited.headers['retry-after'] ??
        (limited.body as { retryAfter?: unknown }).retryAfter;

      expect(retryAfter).toBeDefined();
    });

    it('leaves non-authentication routes serving', async () => {
      const email = uniqueEmail('rl-isolated');
      await attempt(email, STRICT_MAX + 3);

      // The auth surface is limited; the rest of the API is untouched.
      await expect(
        request(app.getHttpServer())
          .get('/health/live')
          .then((r) => r.status),
      ).resolves.toBe(200);

      const protectedRoute = await request(app.getHttpServer()).get(
        '/api/v1/account/two-factor',
      );
      expect(protectedRoute.status).toBe(401);
    });

    it('applies a stricter rate to credential paths than to the rest', () => {
      const config = app.get<AuthConfig>(authConfig.KEY);

      const general = config.rateLimit.max / config.rateLimit.windowSeconds;
      const strict =
        config.rateLimit.strictMax / config.rateLimit.strictWindowSeconds;

      expect(strict).toBeLessThan(general);
    });
  });

  describe('per-account lockout', () => {
    it('trips on repeated failures against one account', async () => {
      const email = uniqueEmail('lockout-trip');

      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await lockout.recordFailure(email);
      }

      const decision = await lockout.check(email);

      expect(decision.locked).toBe(true);
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('refuses a locked account through the HTTP surface', async () => {
      const email = uniqueEmail('lockout-http');

      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await lockout.recordFailure(email);
      }

      const response = await signIn(email);

      expect(response.status).toBe(429);
    });

    /**
     * Unit-level check of the decision function, and only that.
     *
     * Kept because the capped-doubling arithmetic is worth pinning cheaply — the
     * cap in particular takes several rounds to reach, which is slow to observe
     * over HTTP. But it is explicitly *not* evidence that the delay grows in
     * production: calling `recordFailure` in a loop bypasses both Better Auth
     * hooks, and it was passing while HTTP escalation was unreachable. The
     * end-to-end property is asserted in "escalates over the HTTP surface" below.
     */
    it('doubles the wait per failure up to the cap (decision function)', async () => {
      const email = uniqueEmail('lockout-backoff-unit');
      const delays: number[] = [];

      for (let index = 0; index < LOCKOUT_THRESHOLD + 6; index += 1) {
        const decision = await lockout.recordFailure(email);
        if (decision.locked) {
          delays.push(decision.retryAfterSeconds);
        }
      }

      // Strictly increasing at first…
      expect(delays[1]).toBeGreaterThan(delays[0]);
      // …and never past the configured ceiling.
      expect(Math.max(...delays)).toBe(8);
    });

    /**
     * The property the unit check above cannot see: that escalation survives the
     * request flow.
     *
     * Before this change the lock was implied by `failures >= threshold`, and the
     * `after` hook skipped counting on any `429` — so once locked, the counter
     * could never advance, the exponential branch was dead code, and every
     * advertised delay was the base value forever. Nothing failed; the number was
     * simply wrong.
     */
    it('escalates over the HTTP surface as failures continue', async () => {
      const email = uniqueEmail('lockout-http-backoff');
      const advertised: number[] = [];

      await crossLockoutThreshold(email);

      // Three observations: the initial lock, then one after each subsequent
      // genuine failure. Each round waits out the delay it was just told.
      for (let round = 0; round < 3; round += 1) {
        const locked = await unmeteredSignIn(email);

        expect(locked.status).toBe(429);

        const wait = Number(locked.headers['retry-after']);
        advertised.push(wait);

        // A small margin over the advertised wait, then a genuine failure that
        // should be counted and should escalate the next delay.
        await sleep(wait * 1000 + 250);
        await unmeteredSignIn(email);
      }

      expect(advertised[1]).toBeGreaterThan(advertised[0]);
      expect(advertised[2]).toBeGreaterThan(advertised[1]);
    }, 45_000);

    /**
     * The advertised wait is the real one.
     *
     * Previously `retryAfterSeconds` was computed on read and compared against
     * nothing — the actual gate was a fixed 30-second key TTL, so a caller told to
     * wait two seconds was still refused twenty-eight seconds later.
     */
    it('admits the caller who waits exactly the advertised delay', async () => {
      const email = uniqueEmail('lockout-honest-wait');

      await crossLockoutThreshold(email);

      const locked = await unmeteredSignIn(email);
      expect(locked.status).toBe(429);

      const wait = Number(locked.headers['retry-after']);
      expect(wait).toBeGreaterThan(0);

      await sleep(wait * 1000 + 250);

      // Evaluated on its merits now: wrong password, so 4xx — but *not* the 429
      // of a lock that was still in force.
      const afterWaiting = await unmeteredSignIn(email);
      expect(afterWaiting.status).not.toBe(429);
    }, 30_000);

    /**
     * Knocking during a lock does not extend it.
     *
     * The counter-example this guards against is a TTL refreshed on every attempt,
     * which turns a self-healing delay into one an attacker can hold open
     * indefinitely against a victim.
     */
    it('does not extend the window when the caller keeps knocking', async () => {
      const email = uniqueEmail('lockout-knocking');

      await crossLockoutThreshold(email);

      const locked = await unmeteredSignIn(email);
      const wait = Number(locked.headers['retry-after']);
      expect(locked.status).toBe(429);

      // Knock throughout the window rather than waiting quietly.
      const deadline = Date.now() + wait * 1000;
      while (Date.now() < deadline) {
        await unmeteredSignIn(email);
        await sleep(200);
      }

      await sleep(400);

      // The window ended when it would have ended anyway.
      const afterWindow = await unmeteredSignIn(email);
      expect(afterWindow.status).not.toBe(429);
    }, 30_000);

    it('counts by account, so failures from many addresses still trip it', async () => {
      const email = uniqueEmail('lockout-distributed');

      // Each attempt claims a different forwarded address. With TRUST_PROXY off
      // these are ignored for addressing, and the account counter is what bites.
      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await request(app.getHttpServer())
          .post('/api/auth/sign-in/email')
          .set('X-Forwarded-For', `203.0.113.${index + 1}`)
          .send({ email, password: 'wrong-password-entirely' });
      }

      const decision = await lockout.check(email);
      expect(decision.locked).toBe(true);
    });

    it('self-heals: the counter carries a TTL and needs no admin unlock', async () => {
      const email = uniqueEmail('lockout-ttl');

      await lockout.recordFailure(email);

      const keys = await redis.keys('auth:lockout:*');
      expect(keys.length).toBeGreaterThan(0);

      const client = redis as unknown as {
        ttl: (key: string) => Promise<number>;
      };
      const ttls = await Promise.all(keys.map((key) => client.ttl(key)));

      // A positive TTL is what makes the lock temporary rather than sticky.
      expect(Math.max(...ttls)).toBeGreaterThan(0);
    });

    it('clears the counter on a successful sign-in', async () => {
      const email = uniqueEmail('lockout-clear');

      await lockout.recordFailure(email);
      await lockout.recordFailure(email);

      await lockout.clear(email);

      const decision = await lockout.check(email);
      expect(decision.locked).toBe(false);
      expect(decision.retryAfterSeconds).toBe(0);
    });
  });

  describe('reveals nothing about which accounts exist', () => {
    it('consumes counters for an unregistered identifier too', async () => {
      const absent = uniqueEmail('absent-never-registered');

      for (let index = 0; index < LOCKOUT_THRESHOLD; index += 1) {
        await lockout.recordFailure(absent);
      }

      // The limiter cannot be used as an existence oracle.
      const decision = await lockout.check(absent);
      expect(decision.locked).toBe(true);
    });

    it('permits the same number of attempts for present and absent addresses', async () => {
      const absent = uniqueEmail('compare-absent');
      const absentStatuses = await attempt(absent, STRICT_MAX + 2);

      await clearLimiterState();

      const present = uniqueEmail('compare-present');
      createdEmails.push(present);
      await request(app.getHttpServer())
        .post('/api/auth/sign-up/email')
        .send({ email: present, password: TEST_PASSWORD, name: 'Present' });

      const presentStatuses = await attempt(present, STRICT_MAX + 2);

      const countLimited = (statuses: number[]) =>
        statuses.filter((status) => status === 429).length;

      expect(countLimited(presentStatuses)).toBe(countLimited(absentStatuses));
    });
  });

  describe('rate-limit identity is not client-controlled', () => {
    it('ignores a forged forwarded address when proxy trust is off', async () => {
      const email = uniqueEmail('forge');

      // Exhaust the strict limit from the real address.
      await attempt(email, STRICT_MAX + 3);

      // A forged header must not buy a fresh allowance.
      const forged = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('X-Forwarded-For', '198.51.100.42')
        .send({ email, password: 'wrong-password-entirely' });

      expect(forged.status).toBe(429);
    });
  });

  describe('a limiter outage fails closed on the auth surface only', () => {
    /**
     * Fails `INCR` for the auth limiter's counters only, delegating every other
     * key to the live client.
     *
     * The scoping is not fussiness — a blanket `incr` rejection does not test what
     * it appears to. `RedisThrottlerStorage.increment` also issues `INCR` (on
     * `throttle:*` keys), and the application-wide throttler has its **own**
     * documented fail-closed posture returning `503`. So a global mock makes every
     * `/api/v1` route `503` too, and the "sessions still serve" assertion below
     * fails for a reason that has nothing to do with the adapter under test —
     * proving only that a different limiter also fails closed.
     *
     * Keyed on the `auth:ratelimit:` prefix, which exists precisely so these two
     * mechanisms are separable in the keyspace.
     */
    function breakCounterStorage(): jest.SpyInstance {
      const passThrough = redis.incr.bind(redis);

      return jest
        .spyOn(redis, 'incr')
        .mockImplementation((key: string) =>
          key.startsWith('auth:ratelimit:')
            ? Promise.reject(new Error('redis unreachable'))
            : passThrough(key),
        );
    }

    it('refuses a sign-in rather than serving it unmetered', async () => {
      const email = uniqueEmail('outage-signin');
      const spy = breakCounterStorage();

      try {
        const response = await signIn(email);

        /**
         * The regression this exists for: `get` converts a Redis error into
         * `null`, `null` reads as an unused window, and the attempt is admitted.
         * Correct for sessions, catastrophic for a counter — with Redis down the
         * entire credential surface was unmetered.
         */
        expect(response.status).not.toBe(200);
        expect(response.status).toBeGreaterThanOrEqual(400);

        // A temporary condition, not a credential verdict — so a client backs off
        // instead of concluding the password is wrong.
        expect(response.status).toBe(503);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps serving an authenticated request from the durable store', async () => {
      const user = await createVerifiedUser(
        { app, prisma, mail },
        'outage-live',
      );
      createdEmails.push(user.email);

      const spy = breakCounterStorage();

      try {
        const response = await request(app.getHttpServer())
          .get('/api/v1/account/me')
          .set('Cookie', user.cookie);

        /**
         * Both postures in one outage: counters fail closed because nothing is
         * authoritative behind them, while session reads fail open because
         * Postgres is. Collapsing the adapter's two behaviours into one
         * consistent posture would break whichever of these two assertions it was
         * collapsed toward.
         */
        expect(response.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    }, 30_000);
  });

  describe('the ceiling holds under concurrency', () => {
    it('admits no more than the configured maximum when attempts race', async () => {
      const email = uniqueEmail('rl-concurrent');

      /**
       * Issued together rather than in sequence. On the library's non-atomic
       * fallback each of these could read the same pre-increment count and all
       * pass the check before any write landed — the ceiling was advisory, which
       * better-auth itself warns about when a storage has no atomic `consume`.
       */
      const statuses = await Promise.all(
        Array.from({ length: STRICT_MAX + 6 }, () =>
          signIn(email).then((response) => response.status),
        ),
      );

      const admitted = statuses.filter((status) => status !== 429).length;

      expect(admitted).toBeLessThanOrEqual(STRICT_MAX);
      expect(statuses).toContain(429);
    }, 30_000);
  });

  describe('counter keys hold no raw addresses', () => {
    it('stores a hash rather than the identifier', async () => {
      const email = uniqueEmail('hashed');

      await lockout.recordFailure(email);

      const keys = await redis.keys('auth:lockout:*');

      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain(email);
        expect(key).not.toContain('@');
      }
    });

    it('shares one counter across case variants of an address', async () => {
      const email = uniqueEmail('CaseVariant');

      await lockout.recordFailure(email.toLowerCase());
      await lockout.recordFailure(email.toUpperCase());

      const keys = await redis.keys('auth:lockout:*');
      expect(keys).toHaveLength(1);

      /**
       * The record is `{ failures, lockedUntil }` rather than a bare integer — the
       * unlock moment has to be stored, not implied by the key's TTL, or the
       * advertised `Retry-After` is unrelated to when attempts resume.
       */
      const raw = await redis.get(keys[0]);
      expect(JSON.parse(raw as string)).toMatchObject({ failures: 2 });
    });
  });
});
