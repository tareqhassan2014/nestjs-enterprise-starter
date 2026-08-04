import { HttpStatus } from '@nestjs/common';

/**
 * Stable, client-facing error identifiers. Clients branch on `code`; the HTTP
 * status is transport. Codes are additive — later changes contribute their own
 * (`INSUFFICIENT_CREDITS` with the credit ledger, and so on) — but existing
 * codes are a published contract and must not be renamed or repurposed.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_TO_CODE = new Map<number, ErrorCode>([
  [HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST],
  [HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED],
  [HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN],
  [HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
  [HttpStatus.CONFLICT, ErrorCode.CONFLICT],
  [HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED],
  [HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE],
]);

export function errorCodeForStatus(status: number): ErrorCode {
  return STATUS_TO_CODE.get(status) ?? ErrorCode.INTERNAL_ERROR;
}
