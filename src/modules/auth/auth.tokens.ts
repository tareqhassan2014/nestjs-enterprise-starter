/**
 * Injection token for the configured Better Auth instance.
 *
 * A separate module from `auth.factory.ts` so consumers can import the token
 * without pulling in the factory (and therefore the ESM-only `better-auth`
 * graph) at module-load time.
 */
export const AUTH_INSTANCE = Symbol('AUTH_INSTANCE');
