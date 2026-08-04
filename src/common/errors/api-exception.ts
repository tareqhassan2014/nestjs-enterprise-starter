import { HttpException, type HttpStatus } from '@nestjs/common';

import type { ErrorCode } from './error-code';

export interface ApiExceptionPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Throw this when the error code matters to the client. Plain Nest exceptions
 * still work — the filter derives a code from their status — but this is how a
 * handler states the code explicitly and attaches structured details.
 */
export class ApiException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(
    status: HttpStatus,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super({ code, message, details } satisfies ApiExceptionPayload, status);

    this.code = code;
    this.details = details;
  }
}
