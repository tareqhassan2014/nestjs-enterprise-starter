import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ErrorCode } from '@common/errors/error-code';
import {
  IS_PUBLIC_KEY,
  PRINCIPAL_REQUEST_KEY,
} from '@modules/auth/auth.decorators';

import { ENTITLEMENTS, PLAN_SLUGS } from './entitlements';
import { EntitlementsGuard } from './entitlements.guard';
import {
  REQUIRED_ENTITLEMENTS_KEY,
  REQUIRED_PLAN_KEY,
} from './plan.decorators';
import type {
  EffectivePlan,
  PlanResolutionService,
} from './plan-resolution.service';

const LITE_PLAN: EffectivePlan = {
  planId: 'plan-lite',
  slug: PLAN_SLUGS.LITE,
  name: 'Lite',
  rank: 10,
  fromSubscription: false,
  subscriptionId: null,
  status: null,
  interval: null,
  currentPeriodEnd: null,
  entitlements: {
    [ENTITLEMENTS.FEATURE_ADVANCED]: false,
    [ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT]: false,
  },
  usageLimits: {},
};

const PRO_PLAN: EffectivePlan = {
  ...LITE_PLAN,
  planId: 'plan-pro',
  slug: PLAN_SLUGS.PRO,
  name: 'Pro',
  rank: 20,
  fromSubscription: true,
  subscriptionId: 'sub-1',
  status: 'active',
  interval: 'monthly',
  entitlements: {
    [ENTITLEMENTS.FEATURE_ADVANCED]: true,
    [ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT]: false,
  },
};

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWith(
  plan: EffectivePlan,
  overrides: {
    entitlements?: string[];
    plan?: string;
    public?: boolean;
  } = {},
): {
  guard: EntitlementsGuard;
  resolve: jest.Mock;
} {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
    if (key === IS_PUBLIC_KEY) {
      return overrides.public === true ? true : undefined;
    }
    if (key === REQUIRED_ENTITLEMENTS_KEY) {
      return overrides.entitlements;
    }
    if (key === REQUIRED_PLAN_KEY) {
      return overrides.plan;
    }
    return undefined;
  });

  const resolve = jest.fn().mockResolvedValue(plan);
  const plans = {
    resolve,
    hasEntitlement: (effective: EffectivePlan, key: string) =>
      effective.entitlements[key] === true,
    meetsMinimumPlan: (effective: EffectivePlan, slug: string) => {
      const ranks: Record<string, number> = {
        lite: 10,
        pro: 20,
        enterprise: 30,
      };
      return effective.rank >= (ranks[slug] ?? Number.POSITIVE_INFINITY);
    },
  } as unknown as PlanResolutionService;

  return { guard: new EntitlementsGuard(reflector, plans), resolve };
}

describe('EntitlementsGuard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('no-ops when the route has no entitlement annotations', async () => {
    const { guard, resolve } = guardWith(LITE_PLAN);
    const request = {
      [PRINCIPAL_REQUEST_KEY]: { id: 'user-1' },
      method: 'GET',
      originalUrl: '/api/v1/open',
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('denies Lite when feature.advanced is required', async () => {
    const { guard, resolve } = guardWith(LITE_PLAN, {
      entitlements: [ENTITLEMENTS.FEATURE_ADVANCED],
    });
    const request = {
      [PRINCIPAL_REQUEST_KEY]: { id: 'user-1' },
      method: 'GET',
      originalUrl: '/api/v1/advanced',
    };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: ErrorCode.ENTITLEMENT_DENIED,
      status: 403,
    });
    expect(resolve).toHaveBeenCalledWith('user-1');
  });

  it('allows Pro when feature.advanced is required', async () => {
    const { guard } = guardWith(PRO_PLAN, {
      entitlements: [ENTITLEMENTS.FEATURE_ADVANCED],
    });
    const request = {
      [PRINCIPAL_REQUEST_KEY]: { id: 'user-1' },
      method: 'GET',
      originalUrl: '/api/v1/advanced',
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
  });

  it('denies Lite when Pro minimum plan is required', async () => {
    const { guard } = guardWith(LITE_PLAN, { plan: PLAN_SLUGS.PRO });
    const request = {
      [PRINCIPAL_REQUEST_KEY]: { id: 'user-1' },
      method: 'GET',
      originalUrl: '/api/v1/pro-only',
    };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: ErrorCode.ENTITLEMENT_DENIED,
    });
  });

  it('does not re-resolve a session — only PlanResolutionService.resolve', async () => {
    const { guard, resolve } = guardWith(PRO_PLAN, {
      entitlements: [ENTITLEMENTS.FEATURE_ADVANCED],
    });
    const request = {
      [PRINCIPAL_REQUEST_KEY]: { id: 'user-1' },
      method: 'GET',
      originalUrl: '/api/v1/advanced',
    };

    await guard.canActivate(contextFor(request));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('user-1');
  });
});
