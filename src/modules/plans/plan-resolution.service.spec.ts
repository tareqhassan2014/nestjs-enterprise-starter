import { organizationSubject } from '@modules/organizations/billing-subject';

import { PLAN_SLUGS, ENTITLEMENTS } from './entitlements';
import { PlanResolutionService } from './plan-resolution.service';

function serviceWith(prisma: {
  plan: { findMany: jest.Mock };
  subscription: { findMany: jest.Mock };
}): PlanResolutionService {
  return new PlanResolutionService(prisma as never);
}

const LITE = {
  id: 'plan-lite',
  slug: PLAN_SLUGS.LITE,
  name: 'Lite',
  rank: 10,
  entitlements: [
    { entitlementKey: ENTITLEMENTS.FEATURE_ADVANCED, enabled: false },
    { entitlementKey: ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT, enabled: false },
  ],
  usageLimits: [{ feature: 'demo', dailyLimit: 100, weeklyLimit: 500 }],
};

const PRO = {
  id: 'plan-pro',
  slug: PLAN_SLUGS.PRO,
  name: 'Pro',
  rank: 20,
  entitlements: [
    { entitlementKey: ENTITLEMENTS.FEATURE_ADVANCED, enabled: true },
    { entitlementKey: ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT, enabled: false },
  ],
  usageLimits: [{ feature: 'demo', dailyLimit: 1_000, weeklyLimit: 5_000 }],
};

describe('PlanResolutionService', () => {
  it('treats active and past_due as entitled; canceled only within period', () => {
    const service = serviceWith({
      plan: { findMany: jest.fn() },
      subscription: { findMany: jest.fn() },
    });
    const now = new Date('2026-08-05T12:00:00Z');

    expect(service.isEntitled('active', null, now)).toBe(true);
    expect(service.isEntitled('past_due', null, now)).toBe(true);
    expect(
      service.isEntitled('canceled', new Date('2026-08-06T00:00:00Z'), now),
    ).toBe(true);
    expect(
      service.isEntitled('canceled', new Date('2026-08-01T00:00:00Z'), now),
    ).toBe(false);
    expect(service.isEntitled('canceled', null, now)).toBe(false);
  });

  it('falls back to Lite when the user has no entitled subscription', async () => {
    const service = serviceWith({
      plan: { findMany: jest.fn().mockResolvedValue([LITE, PRO]) },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
    });
    await service.reloadMatrices();

    const effective = await service.resolve('user-1');

    expect(effective.slug).toBe(PLAN_SLUGS.LITE);
    expect(effective.fromSubscription).toBe(false);
    expect(effective.entitlements[ENTITLEMENTS.FEATURE_ADVANCED]).toBe(false);
    expect(effective.usageLimits.demo).toEqual({ daily: 100, weekly: 500 });
  });

  it('uses an entitled Pro subscription over Lite fallback', async () => {
    const service = serviceWith({
      plan: { findMany: jest.fn().mockResolvedValue([LITE, PRO]) },
      subscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-1',
            planId: PRO.id,
            status: 'active',
            interval: 'monthly',
            currentPeriodEnd: null,
            updatedAt: new Date(),
          },
        ]),
      },
    });
    await service.reloadMatrices();

    const effective = await service.resolve('user-1');

    expect(effective.slug).toBe(PLAN_SLUGS.PRO);
    expect(effective.fromSubscription).toBe(true);
    expect(effective.entitlements[ENTITLEMENTS.FEATURE_ADVANCED]).toBe(true);
    expect(service.usageCeiling(effective, 'demo', 'day')).toBe(1_000);
  });

  it('falls back to Lite when canceled period has ended', async () => {
    const service = serviceWith({
      plan: { findMany: jest.fn().mockResolvedValue([LITE, PRO]) },
      subscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-1',
            planId: PRO.id,
            status: 'canceled',
            interval: 'yearly',
            currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date(),
          },
        ]),
      },
    });
    await service.reloadMatrices();

    const effective = await service.resolve(
      'user-1',
      new Date('2026-08-05T12:00:00Z'),
    );

    expect(effective.slug).toBe(PLAN_SLUGS.LITE);
    expect(effective.fromSubscription).toBe(false);
  });

  it('compares plan ranks for minimum-plan checks', async () => {
    const service = serviceWith({
      plan: { findMany: jest.fn().mockResolvedValue([LITE, PRO]) },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
    });
    await service.reloadMatrices();

    const lite = await service.resolve('user-1');
    expect(service.meetsMinimumPlan(lite, PLAN_SLUGS.PRO)).toBe(false);

    const pro = {
      ...lite,
      slug: PLAN_SLUGS.PRO,
      rank: 20,
      entitlements: {
        [ENTITLEMENTS.FEATURE_ADVANCED]: true,
        [ENTITLEMENTS.FEATURE_PRIORITY_SUPPORT]: false,
      },
    };
    expect(service.meetsMinimumPlan(pro, PLAN_SLUGS.PRO)).toBe(true);
    expect(service.meetsMinimumPlan(pro, PLAN_SLUGS.LITE)).toBe(true);
  });

  it('resolves an entitled organization subscription for an organization subject', async () => {
    const subscriptionFindMany = jest.fn().mockResolvedValue([
      {
        id: 'sub-org-1',
        planId: PRO.id,
        status: 'active',
        interval: 'monthly',
        currentPeriodEnd: null,
        updatedAt: new Date(),
      },
    ]);
    const service = serviceWith({
      plan: { findMany: jest.fn().mockResolvedValue([LITE, PRO]) },
      subscription: { findMany: subscriptionFindMany },
    });
    await service.reloadMatrices();

    const effective = await service.resolve(organizationSubject('org-1'));

    expect(subscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    );
    expect(effective.slug).toBe(PLAN_SLUGS.PRO);
    expect(effective.fromSubscription).toBe(true);
  });
});
