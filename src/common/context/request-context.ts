import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  requestId: string;

  /**
   * The authenticated principal, set by `AuthGuard` once the session resolves.
   *
   * Absent on public routes and on any request that has not yet reached the
   * guard chain — notably the automatic request-completion log line, which
   * `pino-http` emits from a `finish` listener. Those entries carry `requestId`
   * alone, which is what joins them to the rest of the request.
   */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Per-request state, readable from anywhere in the call stack without being
 * threaded through arguments or injected.
 *
 * Backed by `AsyncLocalStorage` rather than a request-scoped provider: Nest
 * re-instantiates the entire injection subtree of a request-scoped provider on
 * every request, and non-HTTP entry points (queue workers, cron, the seed
 * script) have no request to inject. See design.md decision 3.
 *
 * The store is a record rather than a bare string so later changes can add
 * fields (`userId`, `tenantId`) without reworking the mechanism.
 */
export const RequestContext = {
  run<T>(store: RequestContextStore, callback: () => T): T {
    return storage.run(store, callback);
  },

  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  getUserId(): string | undefined {
    return storage.getStore()?.userId;
  },

  /**
   * Records the authenticated principal on the *current* scope, so code deeper
   * in the call stack — and every subsequent log line — can read it without the
   * session being threaded through arguments.
   *
   * Mutates the existing store rather than opening a new scope: the guard runs
   * inside the scope the middleware opened, and `als.run()` here would create a
   * child scope that ends when the guard returns.
   */
  setUserId(userId: string): void {
    const store = storage.getStore();

    if (store) {
      store.userId = userId;
    }
  },
};
