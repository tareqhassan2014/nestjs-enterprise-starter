import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  requestId: string;
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
};
