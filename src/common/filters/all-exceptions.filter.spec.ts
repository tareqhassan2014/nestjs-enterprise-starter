import {
  type ArgumentsHost,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { RequestContext } from '@common/context/request-context';

import { AllExceptionsFilter } from './all-exceptions.filter';

interface CapturedResponse {
  status: number;
  body: Record<string, any>;
}

function hostFor(url: string, requestId = 'req-1') {
  const captured: CapturedResponse = { status: 0, body: {} };

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: Record<string, any>) {
      captured.body = payload;
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
});
