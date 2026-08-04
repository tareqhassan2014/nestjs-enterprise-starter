import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Inbound correlation IDs are untrusted input: a client can send anything,
 * including log-injection payloads or a multi-kilobyte string. Accept only a
 * conservative shape (which covers UUIDs) and silently regenerate otherwise —
 * a malformed header is a correlation problem, not a reason to reject the
 * request.
 *
 * This value is never used for authorization, cache keys, or anything but
 * correlation.
 */
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isAcceptableRequestId(value: unknown): value is string {
  return typeof value === 'string' && ACCEPTED_REQUEST_ID.test(value);
}

export function resolveRequestId(candidate: unknown): string {
  return isAcceptableRequestId(candidate) ? candidate : randomUUID();
}
