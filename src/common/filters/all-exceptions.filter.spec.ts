import {
  type ArgumentsHost,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { RequestContext } from '@common/context/request-context';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

import { AllExceptionsFilter } from './all-exceptions.filter';

interface CapturedResponse {
  status: number;
  body: Record<string, any>;
  headers: Record<string, string>;
}

function hostFor(url: string, requestId = 'req-1') {
  const captured: CapturedResponse = { status: 0, body: {}, headers: {} };

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: Record<string, any>) {
      captured.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ url, method: 'GET', id: requestId }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  it('logs the original message and stack for an unexpected error', () => {
    const { host, captured } = hostFor('/api/v1/orders');
    const thrown = new Error('connection string invalid: postgres://u:p@host');

    filter.catch(thrown, host);

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body.error.code).toBe('INTERNAL_ERROR');

    const [message, stack] = errorLog.mock.calls[0] as [string, string];
    expect(message).toContain('connection string invalid');
    expect(stack).toContain('all-exceptions.filter.spec');
  });

  it('does not log expected client errors as server failures', () => {
    const { host } = hostFor('/api/v1/orders');

    filter.catch(new NotFoundException('missing'), host);

    expect(errorLog).not.toHaveBeenCalled();
  });

  it('derives the error code from the HTTP status', () => {
    const { host, captured } = hostFor('/api/v1/orders');

    filter.catch(new ForbiddenException(), host);

    expect(captured.status).toBe(HttpStatus.FORBIDDEN);
    expect(captured.body.error.code).toBe('FORBIDDEN');
  });

  it('prefers the ambient request id over the request object', () => {
    const { host, captured } = hostFor('/api/v1/orders', 'from-request');

    RequestContext.run({ requestId: 'from-context' }, () => {
      filter.catch(new NotFoundException(), host);
    });

    expect(captured.body.meta.requestId).toBe('from-context');
  });

  it('falls back to the request id when no scope is active', () => {
    const { host, captured } = hostFor('/api/v1/orders', 'from-request');

    filter.catch(new NotFoundException(), host);

    expect(captured.body.meta.requestId).toBe('from-request');
  });

  it('passes the health payload through untouched on failure', () => {
    const { host, captured } = hostFor('/health/ready');
    const terminusPayload = {
      status: 'error',
      details: { redis: { status: 'down' } },
    };

    filter.catch(new NotFoundException(terminusPayload), host);

    expect(captured.body).toEqual(terminusPayload);
    expect(captured.body).not.toHaveProperty('success');
  });

  it('omits details when there are none', () => {
    const { host, captured } = hostFor('/api/v1/orders');

    filter.catch(new NotFoundException(), host);

    expect(captured.body.error).not.toHaveProperty('details');
  });

  it('preserves RATE_LIMITED from ApiException with Retry-After', () => {
    const { host, captured } = hostFor('/api/v1/fixture/object');

    filter.catch(
      new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.RATE_LIMITED,
        'Too many requests. Try again later.',
        { limit: 20 },
        { 'Retry-After': '8' },
      ),
      host,
    );

    expect(captured.status).toBe(429);
    expect(captured.body.error.code).toBe('RATE_LIMITED');
    expect(captured.headers['retry-after']).toBe('8');
  });

  it('preserves USAGE_LIMIT_EXCEEDED distinct from RATE_LIMITED', () => {
    const { host, captured } = hostFor('/api/v1/fixture/metered');

    filter.catch(
      new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.USAGE_LIMIT_EXCEEDED,
        'Usage limit exceeded for this period.',
        { feature: 'demo', period: 'day', limit: 3, remaining: 0 },
        { 'Retry-After': '3600' },
      ),
      host,
    );

    expect(captured.status).toBe(429);
    expect(captured.body.error.code).toBe('USAGE_LIMIT_EXCEEDED');
    expect(captured.body.error.details).toMatchObject({
      feature: 'demo',
      period: 'day',
    });
    expect(captured.headers['retry-after']).toBe('3600');
  });

  it('maps store-down ApiException to SERVICE_UNAVAILABLE', () => {
    const { host, captured } = hostFor('/api/v1/fixture/object');

    filter.catch(
      new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'Rate limiting temporarily unavailable.',
      ),
      host,
    );

    expect(captured.status).toBe(503);
    expect(captured.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
