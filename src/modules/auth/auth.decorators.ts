import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from './auth.service';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Opens a route to unauthenticated callers.
 *
 * The **only** way to do so — every route is protected by default, so a new
 * controller is safe before anyone thinks about protecting it. Keeping it to one
 * marker also means `rg '@Public'` is a complete audit of the open surface.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/** Where `AuthGuard` stores the resolved principal for the rest of the request. */
export const PRINCIPAL_REQUEST_KEY = 'authPrincipal';

/**
 * Injects the authenticated principal that `AuthGuard` already resolved.
 *
 * Reads what the guard put on the request rather than resolving the session
 * again — one resolution per request is the contract the guard chain rests on.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<{
      [PRINCIPAL_REQUEST_KEY]?: AuthenticatedPrincipal;
    }>();

    const principal = request[PRINCIPAL_REQUEST_KEY];

    if (!principal) {
      // Only reachable if a handler asks for the principal on a @Public route,
      // which is a programming error rather than a client one.
      throw new Error(
        '@CurrentUser() used on a route with no authenticated principal. ' +
          'Remove @Public() from the route, or stop injecting the principal.',
      );
    }

    return principal;
  },
);
