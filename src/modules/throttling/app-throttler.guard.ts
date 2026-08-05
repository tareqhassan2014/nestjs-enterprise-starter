import {
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { throttleConfig } from '@config/throttle.config';
import { PRINCIPAL_REQUEST_KEY } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { STRICT_THROTTLE_KEY } from './throttle.decorators';

/**
 * Nest admission control after auth/RBAC.
 *
 * Tracker: authenticated `user:{id}`, else `ip:{address}` (Express `req.ip`,
 * which already honours `TRUST_PROXY`).
 *
 * Keys are per **policy** per tracker — not per route. Exhausting the default
 * burst on one Nest path still protects the other default paths, which is the
 * property worth having; what the policy segment adds is that a `@StrictThrottle()`
 * route no longer shares a counter with routes held to a different ceiling.
 *
 * That sharing was not a small discrepancy. `handleRequest` substitutes the
 * strict ceiling while the key stayed identical, so with the shipped defaults
 * (`burst` 20/10s against `strict.burst` 10/5s) fifteen ordinary requests left a
 * caller already over the strict ceiling before their first account call. And
 * because `RedisThrottlerStorage` derives its *block* key from this same key, a
 * strict violation used to write a block that denied every Nest route — turning a
 * tighter limit on a sensitive surface into a lever for locking the caller out of
 * the whole API.
 *
 * Redis errors fail closed as `503 SERVICE_UNAVAILABLE`. Limit hits become
 * enveloped `429 RATE_LIMITED` with `Retry-After`.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(throttleConfig.KEY)
    private readonly throttle: ConfigType<typeof throttleConfig>,
  ) {
    super(options, storageService, reflector);
  }

  protected override getTracker(req: Request): Promise<string> {
    const principal = (
      req as Request & { [PRINCIPAL_REQUEST_KEY]?: AuthenticatedPrincipal }
    )[PRINCIPAL_REQUEST_KEY];

    if (principal?.id) {
      return Promise.resolve(`user:${principal.id}`);
    }

    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }

  /**
   * One counter per policy + tracker + named window, shared across the routes
   * governed by that policy.
   *
   * Not the library default, which includes class and handler and would let a
   * caller spend a full allowance on each of many routes. Not the bare tracker
   * either — that shares one count between policies holding it to different
   * ceilings. The policy segment is the smallest thing that separates the two
   * without fragmenting per route.
   *
   * `RedisThrottlerStorage` interpolates this key into both its hits key and its
   * block key, so scoping here scopes both: a block written under one policy
   * cannot deny routes governed by another.
   */
  protected override generateKey(
    context: ExecutionContext,
    tracker: string,
  ): string {
    return `${this.policyFor(context)}:${tracker}`;
  }

  /**
   * Which ceiling set governs this route.
   *
   * Read from the same reflection `handleRequest` uses, through one method, so the
   * key and the ceiling cannot disagree about which policy applies — a
   * disagreement there is exactly the bug this change fixes, and having two
   * readers of the same metadata is how it would come back.
   */
  private policyFor(context: ExecutionContext): 'strict' | 'default' {
    const isStrict = this.reflector.getAllAndOverride<boolean>(
      STRICT_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    return isStrict ? 'strict' : 'default';
  }

  protected override async handleRequest(
    requestProps: Parameters<ThrottlerGuard['handleRequest']>[0],
  ): Promise<boolean> {
    const { context, throttler } = requestProps;

    if (this.policyFor(context) === 'strict') {
      const named = throttler.name === 'minute' ? 'minute' : 'burst';
      const policy = this.throttle.strict[named];
      requestProps.limit = policy.max;
      requestProps.ttl = policy.windowSeconds * 1000;
      requestProps.blockDuration = policy.windowSeconds * 1000;
    }

    try {
      return await super.handleRequest(requestProps);
    } catch (error) {
      if (
        error instanceof ThrottlerException ||
        error instanceof ApiException
      ) {
        throw error;
      }

      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'Rate limiting temporarily unavailable.',
      );
    }
  }

  protected override throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfter = Math.max(1, throttlerLimitDetail.timeToBlockExpire);
    const { res } = this.getRequestResponse(context) as {
      req: Request;
      res: Response;
    };
    res.setHeader('Retry-After', String(retryAfter));

    throw new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      ErrorCode.RATE_LIMITED,
      'Too many requests. Try again later.',
      {
        limit: throttlerLimitDetail.limit,
        remaining: 0,
      },
      { 'Retry-After': String(retryAfter) },
    );
  }
}
