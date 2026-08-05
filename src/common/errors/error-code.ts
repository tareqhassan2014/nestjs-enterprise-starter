import { HttpStatus } from '@nestjs/common';

/**
 * Stable, client-facing error identifiers. Clients branch on `code`; the HTTP
 * status is transport. Codes are additive — later changes contribute their own
 * — but existing codes are a published contract and must not be renamed or
 * repurposed.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * Daily/weekly quota exhausted — distinct from `RATE_LIMITED` (burst/minute).
   * Clients wait for the period reset or upgrade; they do not retry in seconds.
   */
  USAGE_LIMIT_EXCEEDED: 'USAGE_LIMIT_EXCEEDED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  /**
   * Authentication outcomes a client must be able to tell apart, because each
   * has a different remedy. All three are distinct from `UNAUTHORIZED`, which
   * means "no usable session was presented".
   */

  /** A valid session, but the address has not been confirmed. Resend and verify. */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',

  /** Password accepted, second factor outstanding. Complete the challenge. */
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',

  /** Too many failures against this account. Wait — the window expires by itself. */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',

  /**
   * Commercial plan outcomes — distinct from RBAC `FORBIDDEN` so clients can
   * show upgrade / renew UI rather than a generic permission error.
   */

  /** Effective plan lacks a required entitlement or minimum rank. */
  ENTITLEMENT_DENIED: 'ENTITLEMENT_DENIED',

  /** An entitled subscription is required and none is in force. */
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',

  /**
   * Credit wallet balance is below the cost required for the route or spend.
   * Distinct from plan entitlements so clients can prompt a top-up.
   */
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',

  /**
   * Idempotency outcomes for `@Idempotent()` routes — distinct from the
   * generic `BAD_REQUEST` / `CONFLICT` so clients can tell "you forgot the
   * header" from "you reused it with a different payload".
   */

  /** Route requires `Idempotency-Key` and the request did not send one. */
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',

  /** Same key, different method/path/body — the key was not the same request. */
  IDEMPOTENCY_KEY_REUSE: 'IDEMPOTENCY_KEY_REUSE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_TO_CODE = new Map<number, ErrorCode>([
  [HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST],
  [HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED],
  [HttpStatus.PAYMENT_REQUIRED, ErrorCode.INSUFFICIENT_CREDITS],
  [HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN],
  [HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
  [HttpStatus.CONFLICT, ErrorCode.CONFLICT],
  [HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED],
  [HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE],
]);

export function errorCodeForStatus(status: number): ErrorCode {
  return STATUS_TO_CODE.get(status) ?? ErrorCode.INTERNAL_ERROR;
}
