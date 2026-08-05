import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSessionAuth } from '@infrastructure/openapi/api-session-auth.decorator';
import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { PlanResolutionService } from './plan-resolution.service';

interface CurrentPlanView {
  plan: {
    slug: string;
    name: string;
    rank: number;
  };
  fromSubscription: boolean;
  subscription: {
    id: string;
    status: string;
    interval: string;
    currentPeriodEnd: Date | null;
  } | null;
  entitlements: Record<string, boolean>;
  limits: Record<string, { daily: number; weekly: number }>;
}

@ApiTags('Account')
@ApiSessionAuth()
@Controller({ path: 'billing', version: '1' })
export class BillingPlanController {
  constructor(private readonly plans: PlanResolutionService) {}

  @Get('plan')
  async currentPlan(
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<CurrentPlanView> {
    const effective = await this.plans.resolve(user.id);

    return {
      plan: {
        slug: effective.slug,
        name: effective.name,
        rank: effective.rank,
      },
      fromSubscription: effective.fromSubscription,
      subscription:
        effective.subscriptionId && effective.status && effective.interval
          ? {
              id: effective.subscriptionId,
              status: effective.status,
              interval: effective.interval,
              currentPeriodEnd: effective.currentPeriodEnd,
            }
          : null,
      entitlements: { ...effective.entitlements },
      limits: Object.fromEntries(
        Object.entries(effective.usageLimits).map(([feature, ceilings]) => [
          feature,
          { daily: ceilings.daily, weekly: ceilings.weekly },
        ]),
      ),
    };
  }
}
