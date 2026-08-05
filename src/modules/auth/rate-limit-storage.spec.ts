import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

/**
 * Proves the rate limiter runs on its **atomic** path, and that the hook it
 * selects that path by is the one `RedisSecondaryStorage` actually implements.
 *
 * This is a regression guard on a library internal, and it earns its place
 * because the failure is silent in both directions. Better Auth builds an atomic
 * `consume` only `if (secondaryStorage?.increment)` and otherwise falls back to
 * `legacyConsume`, which its own comment describes as "best-effort: simultaneous
 * requests can each pass the check before either write lands", and which reads
 * counters through `get` — the method that returns `null` on a Redis error, so a
 * storage outage would read as a fresh window and admit every credential attempt
 * unmetered.
 *
 * Nothing about that fallback is loud. No error, no failing request; the ceiling
 * simply becomes advisory and the outage posture inverts. So the assertion is
 * behavioural rather than a string match on library source: drive real requests
 * through a real instance and check the library reached for `increment`. If a
 * future version renames the hook, or if our adapter loses the method, this
 * fails here rather than in production.
 *
 * Deliberately not using `RedisSecondaryStorage` itself — that would need a live
 * Redis for what is a question about wiring. The stub stands in for it and
 * records what the library asked for.
 */
describe('rate limiter storage selection', () => {
  /**
   * A `secondaryStorage` that counts in memory and records its calls.
   *
   * `increment` returns the post-increment count because that is what the
   * library compares against `max` (`increment(...) <= rule.max`); returning the
   * pre-increment value would let exactly one attempt over the ceiling through.
   */
  function createRecordingStorage() {
    const counters = new Map<string, number>();
    const calls = { get: 0, set: 0, increment: 0 };

    // Promise-returning rather than `async`: these are synchronous in-memory
    // operations, and marking them async only to satisfy the interface trips
    // `require-await`.
    return {
      calls,
      storage: {
        get: (key: string) => {
          calls.get += 1;
          return Promise.resolve(
            counters.has(key) ? String(counters.get(key)) : null,
          );
        },
        set: () => {
          calls.set += 1;
          return Promise.resolve();
        },
        delete: () => Promise.resolve(),
        increment: (key: string) => {
          calls.increment += 1;
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          return Promise.resolve(next);
        },
      },
    };
  }

  function createInstance(
    storage: ReturnType<typeof createRecordingStorage>['storage'],
  ) {
    return betterAuth({
      appName: 'rate-limit-storage-spec',
      secret: 'test-secret-value-that-is-long-enough-to-pass',
      baseURL: 'http://localhost:3000',
      basePath: '/api/auth',
      database: memoryAdapter({}),
      secondaryStorage: storage,
      emailAndPassword: { enabled: true },
      rateLimit: {
        enabled: true,
        storage: 'secondary-storage',
        window: 60,
        max: 1,
        customRules: {
          '/sign-in/email': { window: 60, max: 1 },
        },
      },
    });
  }

  /**
   * One request at the limited path, reporting only its status.
   *
   * A throw is reported as `500` rather than propagated. The limiter runs in the
   * library's request phase, before routing, so what the route itself does with
   * a throwaway credential — including failing against a bare memory adapter —
   * says nothing about the question here. Collapsing it keeps each assertion
   * about the limiter.
   */
  async function attempt(auth: ReturnType<typeof createInstance>) {
    try {
      const response = await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.7',
          },
          body: JSON.stringify({
            email: 'nobody@example.test',
            password: 'irrelevant-to-this-spec',
          }),
        }),
      );

      return response.status;
    } catch {
      return 500;
    }
  }

  it('consumes counters through increment rather than the legacy read path', async () => {
    const { storage, calls } = createRecordingStorage();
    const auth = createInstance(storage);

    await attempt(auth);

    // The library reached for the atomic hook. If it had fallen back to
    // `legacyConsume`, this would be 0 and the counter would have been read
    // through `get` instead.
    expect(calls.increment).toBeGreaterThan(0);
  });

  it('refuses the attempt that crosses the ceiling', async () => {
    const { storage } = createRecordingStorage();
    const auth = createInstance(storage);

    await attempt(auth);

    // max is 1, so the second attempt is over the ceiling. This also confirms
    // the post-increment return value is compared the way the library expects:
    // returning the pre-increment count would let exactly one extra through.
    expect(await attempt(auth)).toBe(429);
  });

  it('never admits the request when the counter store throws', async () => {
    const { storage } = createRecordingStorage();
    const auth = createInstance({
      ...storage,
      increment: () => Promise.reject(new Error('redis unreachable')),
    });

    /**
     * The fail-closed property at the library boundary: a throwing counter must
     * not resolve to an admitted request. Note the throw escapes `handler()`
     * rather than becoming a response — which is exactly why
     * `BetterAuthMiddleware` has to answer it with the library's own status, and
     * why the e2e coverage asserts the `503` a client actually receives.
     */
    expect(await attempt(auth)).not.toBe(200);
  });
});
