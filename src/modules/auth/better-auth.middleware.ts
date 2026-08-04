import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';

import type { AuthInstance } from './auth.factory';
import { AUTH_INSTANCE } from './auth.tokens';
import { stampClientIp } from './client-ip';

/**
 * Hands `/api/auth/*` to Better Auth's own router.
 *
 * Registered through `MiddlewareConsumer` rather than `app.use()` in
 * `configureApp`, and the difference matters: middleware registered with
 * `app.use()` before `init()` runs *ahead* of everything Nest registers,
 * including `RequestContextMiddleware`. A raw mount would therefore put every
 * authentication request outside the correlation scope and strip `requestId`
 * from exactly the log lines most worth correlating.
 *
 * This handler ends the response itself, so no route is ever reached — which is
 * why body parsers are registered after it and excluded from its paths (see
 * `AppModule.configure`). `toNodeHandler` reads the raw stream, and a body that
 * Nest had already parsed and consumed would leave the request hanging.
 */
@Injectable()
export class BetterAuthMiddleware implements NestMiddleware {
  private readonly handler: (
    request: Request,
    response: Response,
  ) => Promise<void>;

  constructor(@Inject(AUTH_INSTANCE) auth: AuthInstance) {
    this.handler = toNodeHandler(auth) as (
      request: Request,
      response: Response,
    ) => Promise<void>;
  }

  use(request: Request, response: Response, next: NextFunction): void {
    // Overwrites any client-supplied value, so the address the limiter and the
    // lockout counters key on cannot be forged.
    stampClientIp(request);

    this.restoreOriginalUrl(request);
    this.mirrorRetryAfter(response);

    this.handler(request, response).catch(next);
  }

  /**
   * Emits a standard `Retry-After` alongside the library's `X-Retry-After`.
   *
   * Better Auth's limiter sets only the `X-` variant, which no HTTP client,
   * proxy, or SDK understands — so a rate-limited caller is told to wait in a
   * header nothing reads. Rather than replacing it (some Better Auth clients look
   * for it), the value is copied to the conventional header.
   *
   * Done by wrapping `writeHead` because headers are already committed by the
   * time the handler resolves: this is the last point at which the response is
   * still mutable.
   */
  private mirrorRetryAfter(response: Response): void {
    const originalWriteHead = response.writeHead.bind(response);

    response.writeHead = ((...args: Parameters<Response['writeHead']>) => {
      const retryAfter = response.getHeader('x-retry-after');

      if (retryAfter !== undefined && !response.hasHeader('retry-after')) {
        response.setHeader('retry-after', String(retryAfter));
      }

      return originalWriteHead(...args);
    }) as Response['writeHead'];
  }

  /**
   * Presents the request as if it had been routed, not mounted — which is what
   * Better Auth's Node adapter assumes.
   *
   * Nest mounts middleware with a wildcard pattern, so Express absorbs the whole
   * matched path into `req.baseUrl` and leaves `req.url` as `/`. better-call's
   * `constructRelativeUrl` then hits its final branch and returns **`baseUrl`
   * alone — dropping the query string**:
   *
   *     if (baseUrl + req.url === originalUrl) return baseUrl + req.url;
   *     return originalUrl.split("?")[0].at(-1) === "/" ? baseUrl + req.url : baseUrl;
   *
   * POSTs carry their data in the body and so appear to work, which is what makes
   * this worth guarding: the failure is invisible until a *query-carrying GET*
   * arrives — email verification, password reset, every OAuth callback — and then
   * presents as "invalid token" rather than as a mount problem.
   *
   * Clearing `baseUrl` takes the adapter's first branch (`!baseUrl`), so it uses
   * the full original URL, query included. This reproduces exactly what the
   * library's documented `app.all('/api/auth/*', …)` recipe produces, where
   * routing leaves `baseUrl` empty.
   *
   * Safe because this handler terminates the response: nothing downstream reads
   * either property afterwards.
   */
  private restoreOriginalUrl(request: Request): void {
    request.url = request.originalUrl;
    request.baseUrl = '';
  }
}
