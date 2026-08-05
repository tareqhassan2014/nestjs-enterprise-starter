import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { lastValueFrom } from 'rxjs';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import {
  IS_PUBLIC_KEY,
  PRINCIPAL_REQUEST_KEY,
} from '@modules/auth/auth.decorators';

import { userSubject } from '@modules/organizations/billing-subject';
import type { BillingSubjectResolver } from '@modules/organizations/billing-subject.resolver';

import { COSTS_CREDITS_KEY } from './credit.decorators';
import { CreditsRefundInterceptor } from './credits-refund.interceptor';
import { CREDITS_SPEND_REQUEST_KEY, CreditsGuard } from './credits.guard';
import type { CreditService } from './credit.service';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CreditsGuard', () => {
  function build(overrides: {
    feature?: string;
    public?: boolean;
    principal?: { id: string } | null;
    spend?: jest.Mock;
  }): {
    guard: CreditsGuard;
    spend: jest.Mock;
    request: Record<string, unknown>;
  } {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === IS_PUBLIC_KEY) {
        return overrides.public === true ? true : undefined;
      }
      if (key === COSTS_CREDITS_KEY) {
        return overrides.feature;
      }
      return undefined;
    });

    const spend =
      overrides.spend ?? jest.fn().mockResolvedValue({ balance: 0 });
    const credits = { spend } as unknown as CreditService;
    const billingSubjects = {
      resolve: jest.fn((userId: string) => userSubject(userId)),
    } as unknown as BillingSubjectResolver;
    const guard = new CreditsGuard(reflector, credits, billingSubjects);

    const request: Record<string, unknown> = {
      method: 'POST',
      originalUrl: '/api/v1/billing/demo/paid',
    };
    if (overrides.principal !== null) {
      request[PRINCIPAL_REQUEST_KEY] = overrides.principal ?? {
        id: 'user-1',
        email: 'a@b.co',
        name: 'A',
        emailVerified: true,
        twoFactorEnabled: false,
      };
    }

    return { guard, spend, request };
  }

  it('no-ops when undecorated', async () => {
    const { guard, spend, request } = build({});
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(spend).not.toHaveBeenCalled();
  });

  it('spends when balance is sufficient', async () => {
    const { guard, spend, request } = build({ feature: 'demo.paid' });
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(spend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: userSubject('user-1'),
        amount: 1,
        feature: 'demo.paid',
      }),
    );
    expect(request[CREDITS_SPEND_REQUEST_KEY]).toBeDefined();
  });

  it('denies with INSUFFICIENT_CREDITS without marking spend', async () => {
    const spend = jest
      .fn()
      .mockRejectedValue(
        new ApiException(
          402,
          ErrorCode.INSUFFICIENT_CREDITS,
          'Insufficient credits.',
        ),
      );
    const { guard, request } = build({ feature: 'demo.paid', spend });

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_CREDITS,
    });
    expect(request[CREDITS_SPEND_REQUEST_KEY]).toBeUndefined();
  });

  it('does not call CreditService when public', async () => {
    const { guard, spend, request } = build({
      feature: 'demo.paid',
      public: true,
    });
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(spend).not.toHaveBeenCalled();
  });
});

describe('CreditsRefundInterceptor', () => {
  it('refunds on handler failure when a spend marker is present', async () => {
    const refund = jest.fn().mockResolvedValue({});
    const interceptor = new CreditsRefundInterceptor({
      refund,
    } as unknown as CreditService);

    const request: Record<string, unknown> = {
      [CREDITS_SPEND_REQUEST_KEY]: {
        subject: userSubject('user-1'),
        feature: 'demo.paid',
        amount: 1,
        spendIdempotencyKey: 'spend:r:demo.paid',
        refundIdempotencyKey: 'refund:r:demo.paid',
      },
    };

    const context = contextFor(request);
    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');

    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: userSubject('user-1'),
        amount: 1,
        idempotencyKey: 'refund:r:demo.paid',
        feature: 'demo.paid',
      }),
    );
  });

  it('does not refund on success', async () => {
    const refund = jest.fn();
    const interceptor = new CreditsRefundInterceptor({
      refund,
    } as unknown as CreditService);

    const request: Record<string, unknown> = {
      [CREDITS_SPEND_REQUEST_KEY]: {
        subject: userSubject('user-1'),
        feature: 'demo.paid',
        amount: 1,
        spendIdempotencyKey: 'spend:r:demo.paid',
        refundIdempotencyKey: 'refund:r:demo.paid',
      },
    };

    await lastValueFrom(
      interceptor.intercept(contextFor(request), {
        handle: () => of({ ok: true }),
      }),
    );

    expect(refund).not.toHaveBeenCalled();
  });
});
