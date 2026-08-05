import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Request, Response } from 'express';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode, errorCodeForStatus } from '@common/errors/error-code';
import { isHealthPath, requestPath } from '@common/http/health-routes';
import { isMcpPath } from '@common/http/mcp-routes';
import {
  type ErrorEnvelope,
  buildResponseMeta,
} from '@common/http/response-envelope';
import { PRINCIPAL_REQUEST_KEY } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import {
  type LimitExceededPayload,
  OBS_LIMIT_EXCEEDED_EVENT,
} from '@modules/metrics/observability.events';

/**
 * Prisma's known-error class, duck-typed rather than imported.
 *
 * The generated client lives under `src/generated/` and is gitignored, so a
 * fresh clone typechecks before `prisma generate` has ever run. Matching on
 * shape keeps the filter decoupled from the generator's output path.
 */
interface PrismaKnownRequestError {
  name: string;
  code: string;
  message: string;
}

function isPrismaKnownRequestError(
  error: unknown,
): error is PrismaKnownRequestError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PrismaClientKnownRequestError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/**
 * Better Auth's error class, duck-typed for the same reason as Prisma's above:
 * matching on shape avoids importing from an ESM-only package here, and this
 * filter is loaded on every request path including ones that never touch auth.
 *
 * Reached when a first-party controller calls `auth.api.*` directly — the
 * library's own routes never enter Nest's filter at all. Without this, an
 * ordinary "invalid code" would surface as a `500 INTERNAL_ERROR`.
 */
interface BetterAuthApiError {
  name: string;
  statusCode: number;
  body?: { code?: unknown; message?: unknown };
}

function isBetterAuthApiError(error: unknown): error is BetterAuthApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'APIError' &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}

interface ResolvedError {
  status: HttpStatus;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * The single place that decides what reaches a client. Every error — thrown
 * `HttpException`, Prisma failure, or an unexpected throw from anywhere in the
 * stack — leaves through here in the uniform envelope, and nothing internal
 * (stack traces, SQL, connection strings) goes with it.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(@Optional() private readonly events?: EventEmitter2) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { id?: unknown }>();
    const response = ctx.getResponse<Response>();

    /**
     * Health probes and MCP transport are carve-outs: orchestrators / MCP clients
     * need raw payloads, not the Nest success/error envelope.
     */
    if (
      (isHealthPath(requestPath(request)) ||
        isMcpPath(requestPath(request))) &&
      exception instanceof HttpException
    ) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const resolved = this.resolve(exception);
    this.observeLimitExceeded(resolved, request);

    if (resolved.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // The original error is logged in full, with the correlation ID, and
      // deliberately not returned.
      this.logger.error(
        `${request.method} ${request.url} failed: ${describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (exception instanceof ApiException && exception.headers) {
      for (const [name, value] of Object.entries(exception.headers)) {
        response.setHeader(name, value);
      }
    }

    const body: ErrorEnvelope = {
      success: false,
      error: {
        code: resolved.code,
        message: resolved.message,
        ...(resolved.details === undefined
          ? {}
          : { details: resolved.details }),
      },
      meta: buildResponseMeta(request.id),
    };

    response.status(resolved.status).json(body);
  }

  private observeLimitExceeded(
    resolved: ResolvedError,
    request: Request,
  ): void {
    if (
      resolved.code !== ErrorCode.RATE_LIMITED &&
      resolved.code !== ErrorCode.USAGE_LIMIT_EXCEEDED
    ) {
      return;
    }

    const principal = (
      request as Request & { [PRINCIPAL_REQUEST_KEY]?: AuthenticatedPrincipal }
    )[PRINCIPAL_REQUEST_KEY];

    const payload: LimitExceededPayload = {
      code: resolved.code,
      subject: principal?.id ?? `ip:${request.ip ?? 'unknown'}`,
      route:
        (request as Request & { route?: { path?: string } }).route?.path ??
        requestPath(request) ??
        'unknown',
    };

    this.events?.emit(OBS_LIMIT_EXCEEDED_EVENT, payload);
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      return {
        status,
        code: errorCodeForStatus(status),
        message: messageFromHttpException(exception),
      };
    }

    if (isPrismaKnownRequestError(exception)) {
      return resolvePrismaError(exception);
    }

    if (isBetterAuthApiError(exception)) {
      return resolveBetterAuthError(exception);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    };
  }
}

function resolvePrismaError(error: PrismaKnownRequestError): ResolvedError {
  switch (error.code) {
    case 'P2002':
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'A record with these values already exists.',
      };
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'The requested record was not found.',
      };
    default:
      // Unmapped database errors are internal detail; the raw text is logged.
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
      };
  }
}

/**
 * Translates a Better Auth failure into the application envelope.
 *
 * The library's own `code` (`INVALID_CODE`, `INVALID_PASSWORD`, …) is a different
 * vocabulary from ours and is deliberately not forwarded as our `error.code` —
 * that field is a published contract, and letting a dependency extend it would
 * mean a library upgrade could silently change what clients receive. The status
 * is honoured, our code is derived from it, and the library's message is passed
 * through because it is the part that tells the user what to fix.
 */
function resolveBetterAuthError(error: BetterAuthApiError): ResolvedError {
  const status = error.statusCode;

  const message =
    typeof error.body?.message === 'string'
      ? error.body.message
      : 'The request could not be completed.';

  // A 5xx from the library is still an internal failure: say nothing specific.
  // Compared as a plain number: `statusCode` comes from the library, not from
  // Nest's HttpStatus enum, so they share no enum type.
  if (status >= 500) {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    };
  }

  return { status, code: errorCodeForStatus(status), message };
}

function messageFromHttpException(exception: HttpException): string {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  const message = (response as { message?: unknown }).message;

  if (typeof message === 'string') {
    return message;
  }

  if (Array.isArray(message)) {
    return message.join('; ');
  }

  return exception.message;
}

function describe(exception: unknown): string {
  if (exception instanceof Error) {
    return `${exception.name}: ${exception.message}`;
  }

  return String(exception);
}
