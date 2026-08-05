import { createHash } from 'node:crypto';

import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { Prisma } from '@/generated/prisma/client';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { idempotencyConfig } from '@config/idempotency.config';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { PRINCIPAL_REQUEST_KEY } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { IDEMPOTENT_KEY } from './idempotent.decorator';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Nest's own default when a handler carries no `@HttpCode()` override. */
function defaultStatusForMethod(method: string): HttpStatus {
  return method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
}

interface PrismaUniqueViolation {
  name: string;
  code: string;
}

function isUniqueViolation(error: unknown): error is PrismaUniqueViolation {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PrismaClientKnownRequestError' &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Applies `@Idempotent()`: requires the header, fingerprints the request,
 * and replays the stored response for a retry instead of re-running the
 * handler. Postgres (`IdempotencyRecord`) is the source of truth rather than
 * Redis, so a cache wipe cannot cause a duplicate side effect.
 *
 * Registered globally (`APP_INTERCEPTOR`) and a no-op on every route without
 * the decorator, so adding it costs nothing for the rest of the API.
 *
 * Concurrency: the first writer inserts a `processing` row; a second request
 * with the same key racing it loses the unique-constraint race and gets a
 * `409` rather than running the handler twice. A handler that throws deletes
 * its own `processing` row, so the same key can be retried after a failure.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(idempotencyConfig.KEY)
    private readonly config: ConfigType<typeof idempotencyConfig>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) {
      return next.handle();
    }

    return from(this.handle(context, next));
  }

  private async handle(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.extractKey(request);
    const principalId = this.principalIdOf(request);
    const requestHash = this.hashRequest(request);

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { principalId_key: { principalId, key } },
    });

    if (existing) {
      return this.replay(existing, requestHash, key);
    }

    await this.beginProcessing({ principalId, key, request, requestHash });

    try {
      const result = (await lastValueFrom(next.handle())) as unknown;

      await this.prisma.idempotencyRecord.update({
        where: { principalId_key: { principalId, key } },
        data: {
          status: 'completed',
          statusCode: this.resolveStatusCode(context, request.method),
          responseBody: result as Prisma.InputJsonValue,
        },
      });

      return result;
    } catch (error) {
      // A failed handler applied no side effect worth remembering; drop the
      // processing row so a retry with the same key can run again.
      await this.prisma.idempotencyRecord
        .delete({ where: { principalId_key: { principalId, key } } })
        .catch(() => undefined);
      throw error;
    }
  }

  private replay(
    existing: {
      requestHash: string;
      status: string;
      responseBody: unknown;
    },
    requestHash: string,
    key: string,
  ): unknown {
    if (existing.requestHash !== requestHash) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.IDEMPOTENCY_KEY_REUSE,
        'Idempotency-Key was reused with a different request.',
        { key },
      );
    }

    if (existing.status !== 'completed') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'A request with this Idempotency-Key is already being processed.',
        { key },
      );
    }

    this.logger.debug({ msg: 'Idempotency replay', key });
    return existing.responseBody;
  }

  private async beginProcessing(params: {
    principalId: string;
    key: string;
    request: Request;
    requestHash: string;
  }): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          principalId: params.principalId,
          key: params.key,
          method: params.request.method,
          path: params.request.originalUrl ?? params.request.url,
          requestHash: params.requestHash,
          status: 'processing',
          expiresAt: new Date(Date.now() + this.config.ttlSeconds * 1000),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'A request with this Idempotency-Key is already being processed.',
          { key: params.key },
        );
      }
      throw error;
    }
  }

  private extractKey(request: Request): string {
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;

    if (!key || key.trim() === '') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        `This route requires an "${IDEMPOTENCY_KEY_HEADER}" header.`,
      );
    }

    if (key.length > this.config.keyMaxLength) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        `Idempotency-Key must not exceed ${this.config.keyMaxLength} characters.`,
      );
    }

    return key;
  }

  private principalIdOf(request: Request): string {
    const principal = (
      request as Request & {
        [PRINCIPAL_REQUEST_KEY]?: AuthenticatedPrincipal;
      }
    )[PRINCIPAL_REQUEST_KEY];

    if (!principal) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
      );
    }

    return principal.id;
  }

  private hashRequest(request: Request): string {
    const payload = JSON.stringify({
      method: request.method,
      path: request.originalUrl ?? request.url,
      body: (request.body ?? {}) as unknown,
    });

    return createHash('sha256').update(payload).digest('hex');
  }

  private resolveStatusCode(context: ExecutionContext, method: string): number {
    return (
      this.reflector.getAllAndOverride<number>(HTTP_CODE_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? defaultStatusForMethod(method)
    );
  }
}
