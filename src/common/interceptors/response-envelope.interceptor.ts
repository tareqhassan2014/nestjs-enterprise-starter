import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type Observable, map } from 'rxjs';

import { NO_ENVELOPE_KEY } from '@common/decorators/no-envelope.decorator';
import { buildResponseMeta } from '@common/http/response-envelope';

/**
 * Wraps every successful handler return in the uniform envelope. Applied
 * globally so endpoints get the contract by default rather than by opting in —
 * handlers return their payload and nothing else.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const exempt = this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (exempt) {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { id?: unknown }>();

    return next.handle().pipe(
      map((data: unknown) => ({
        success: true as const,
        // A handler that returns nothing still yields a well-formed envelope.
        data: data ?? null,
        meta: buildResponseMeta(request.id),
      })),
    );
  }
}
