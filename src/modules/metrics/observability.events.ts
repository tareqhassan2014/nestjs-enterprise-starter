export const OBS_LIMIT_EXCEEDED_EVENT = 'observability.limit_exceeded';

export type LimitExceededCode = 'RATE_LIMITED' | 'USAGE_LIMIT_EXCEEDED';

export interface LimitExceededPayload {
  code: LimitExceededCode;
  /** Authenticated user id or IP tracker without the `user:` / `ip:` prefix preference — raw subject key. */
  subject: string;
  route: string;
}
