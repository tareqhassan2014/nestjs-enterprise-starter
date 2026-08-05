/**
 * The permission cache's version marker, in one place callable from anywhere.
 *
 * Extracted from `PermissionResolver` rather than living as a method on it
 * because the processes that most need to invalidate are not the application:
 * `prisma/seed.ts` rewrites role→permission mappings and has its own
 * `PrismaClient`, no Nest container, and no injected Redis. A method reachable
 * only through dependency injection made the guarantee "a mutation is observed
 * on the next request" an artefact of the test harness — thirteen call sites,
 * every one of them in `test/`.
 *
 * Deliberately typed against the two commands it uses rather than `ioredis`'s
 * `Redis`, so a caller can pass a short-lived client, the shared singleton, or a
 * stub without this module reaching for a Nest provider.
 */
export interface VersionStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'NX'): Promise<unknown>;
  incr(key: string): Promise<number>;
}

/** Bumped by any role, mapping, or assignment change. */
export const PERMISSION_VERSION_KEY = 'authz:version';

/**
 * How long a cached effective-permission set may outlive a mutation that did not
 * advance the marker.
 *
 * Exported because it is the documented staleness bound, not an implementation
 * detail: an operator editing mappings directly in the database — with no
 * invalidation — needs to know the worst case is this many seconds, and reading
 * it off a constant in a service file is not a contract.
 */
export const PERMISSION_CACHE_TTL_SECONDS = 300;

/**
 * Seeds the marker from the current clock the first time it is needed.
 *
 * Deliberately not from zero. If the key is lost — eviction, a flush, a fresh
 * Redis — restarting at zero could make entries written under an earlier version
 * readable again, resurrecting stale permissions. Seeding from a timestamp makes
 * the counter monotonic across restarts: it can only ever jump forward.
 */
async function ensureVersionKey(store: VersionStore): Promise<string> {
  await store.set(PERMISSION_VERSION_KEY, `${Date.now()}`, 'NX');

  return PERMISSION_VERSION_KEY;
}

/** The current marker, or `null` when it cannot be read. */
export async function readPermissionVersion(
  store: VersionStore,
): Promise<number | null> {
  const raw = await store.get(await ensureVersionKey(store));

  return raw === null ? null : Number.parseInt(raw, 10);
}

/**
 * Invalidates every cached permission set by advancing the version.
 *
 * A bump rather than a delete: a single role's mapping can affect thousands of
 * users, and there is no key to enumerate for "everyone who holds this role".
 * Entries written under the previous version simply become unreachable and expire
 * on their TTL. Costs memory for a few minutes; never serves stale.
 */
export async function advancePermissionVersion(
  store: VersionStore,
): Promise<number> {
  return store.incr(await ensureVersionKey(store));
}
