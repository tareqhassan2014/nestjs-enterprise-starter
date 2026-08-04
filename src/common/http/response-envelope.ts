import { RequestContext } from '@common/context/request-context';
import type { ErrorCode } from '@common/errors/error-code';

export interface ResponseMeta {
  requestId?: string;
  timestamp: string;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  meta: ResponseMeta;
}

export function buildResponseMeta(fallbackRequestId?: unknown): ResponseMeta {
  const contextId = RequestContext.getRequestId();
  const requestId =
    contextId ??
    (typeof fallbackRequestId === 'string' ? fallbackRequestId : undefined);

  return {
    requestId,
    timestamp: new Date().toISOString(),
  };
}
