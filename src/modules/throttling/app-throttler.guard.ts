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
 * which already honours `TRUST_PROXY`). Keys are global per tracker — not
 * per-route — so exhausting burst on one Nest path protects the rest.
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
   * One counter per tracker + named window, shared across Nest routes.
   * The default library key includes class/handler and would fragment limits.
   */
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
  ): string {
    return tracker;
  }

  protected override async handleRequest(
    requestProps: Parameters<ThrottlerGuard['handleRequest']>[0],
  ): Promise<boolean> {
    const { context, throttler } = requestProps;
    const isStrict = this.reflector.getAllAndOverride<boolean>(
      STRICT_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isStrict) {
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
