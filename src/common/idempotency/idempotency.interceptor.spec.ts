import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';

import { ErrorCode } from '@common/errors/error-code';
import { PRINCIPAL_REQUEST_KEY } from '@modules/auth/auth.decorators';

import { IDEMPOTENT_KEY } from './idempotent.decorator';
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyInterceptor,
} from './idempotency.interceptor';

interface RecordRow {
  principalId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  status: string;
  statusCode: number | null;
  responseBody: unknown;
}

function contextFor(
  request: Record<string, unknown>,
  response: { status: jest.Mock } = { status: jest.fn() },
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function build(options?: { required?: boolean; httpCode?: number }) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
    if (key === IDEMPOTENT_KEY) {
      return options?.required ?? true;
    }
    return options?.httpCode;
  });

  const records = new Map<string, RecordRow>();
  const recordKey = (principalId: string, key: string) =>
    `${principalId}:${key}`;

  const prisma = {
    idempotencyRecord: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: { principalId_key: { principalId: string; key: string } };
        }) =>
          records.get(
            recordKey(
              where.principalId_key.principalId,
              where.principalId_key.key,
            ),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: RecordRow }) => {
        const id = recordKey(data.principalId, data.key);
        if (records.has(id)) {
          throw Object.assign(new Error('Unique constraint violation'), {
            name: 'PrismaClientKnownRequestError',
            code: 'P2002',
          });
        }
        records.set(id, { ...data });
        return await Promise.resolve(data);
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { principalId_key: { principalId: string; key: string } };
          data: Partial<RecordRow>;
        }) => {
          const id = recordKey(
            where.principalId_key.principalId,
            where.principalId_key.key,
          );
          const existing = records.get(id)!;
          const updated = { ...existing, ...data };
          records.set(id, updated);
          return updated;
        },
      ),
      delete: jest.fn(
        ({
          where,
        }: {
          where: { principalId_key: { principalId: string; key: string } };
        }) => {
          records.delete(
            recordKey(
              where.principalId_key.principalId,
              where.principalId_key.key,
            ),
          );
          return Promise.resolve();
        },
      ),
    },
  };

  const interceptor = new IdempotencyInterceptor(reflector, prisma as never, {
    ttlSeconds: 86400,
    keyMaxLength: 128,
  });

  return { interceptor, records, prisma };
}

function requestFor(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    originalUrl: '/api/v1/organizations',
    headers: { [IDEMPOTENCY_KEY_HEADER]: 'key-1' },
    body: { name: 'Acme' },
    [PRINCIPAL_REQUEST_KEY]: { id: 'user-1' },
    ...overrides,
  };
}

describe('IdempotencyInterceptor', () => {
  it('passes through when the route is not decorated', async () => {
    const { interceptor } = build({ required: false });
    const request = requestFor();
    const result = await lastValueFrom(
      interceptor.intercept(contextFor(request), {
        handle: () => of({ ok: true }),
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects a missing Idempotency-Key header', async () => {
    const { interceptor } = build();
    const request = requestFor({ headers: {} });

    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor(request), {
          handle: () => of({ ok: true }),
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED });
  });

  it('stores the response on first success and returns it', async () => {
    const { interceptor, records } = build();
    const request = requestFor();

    const result = await lastValueFrom(
      interceptor.intercept(contextFor(request), {
        handle: () => of({ success: true, data: { id: 'org-1' } }),
      }),
    );

    expect(result).toEqual({ success: true, data: { id: 'org-1' } });
    const stored = records.get('user-1:key-1');
    expect(stored?.status).toBe('completed');
    expect(stored?.responseBody).toEqual({
      success: true,
      data: { id: 'org-1' },
    });
  });

  it('replays the stored response for the same key + body without calling the handler', async () => {
    const { interceptor } = build();
    const request = requestFor();
    const handle = jest.fn(() => of({ success: true, data: { id: 'org-1' } }));

    await lastValueFrom(interceptor.intercept(contextFor(request), { handle }));
    const second = await lastValueFrom(
      interceptor.intercept(contextFor(requestFor()), { handle }),
    );

    expect(second).toEqual({ success: true, data: { id: 'org-1' } });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of the same key with a different body', async () => {
    const { interceptor } = build();
    const request = requestFor();

    await lastValueFrom(
      interceptor.intercept(contextFor(request), {
        handle: () => of({ success: true, data: {} }),
      }),
    );

    const different = requestFor({ body: { name: 'Different Corp' } });
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor(different), {
          handle: () => of({ success: true, data: {} }),
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REUSE });
  });

  it('rejects a concurrent duplicate that loses the create race', async () => {
    // Two requests with the same key both pass the `findUnique` miss (neither
    // has committed yet) and race to `create`; the loser hits the unique
    // constraint (P2002), modelled here by making `create` throw it directly.
    const { interceptor, prisma } = build();
    prisma.idempotencyRecord.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint violation'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
      }),
    );

    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor(requestFor()), {
          handle: () => of({ ok: true }),
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('drops the processing row when the handler fails, so a retry can run again', async () => {
    const { interceptor, records } = build();
    const request = requestFor();

    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor(request), {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');

    expect(records.has('user-1:key-1')).toBe(false);
  });
});
