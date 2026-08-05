import { Controller, Get, Module } from '@nestjs/common';

import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import { ENTITLEMENTS, PLAN_SLUGS } from '@modules/plans/entitlements';
import {
  RequireEntitlement,
  RequirePlan,
} from '@modules/plans/plan.decorators';
import { USAGE_FEATURES } from '@modules/usage-limits/usage-features';
import { UsageLimit } from '@modules/usage-limits/usage-limit.decorator';

/**
 * Authenticated fixture routes for plan/entitlement e2e — not part of the
 * product API surface.
 */
@Controller({ path: 'fixture', version: '1' })
export class PlansFixtureController {
  @Get('advanced')
  @RequireEntitlement(ENTITLEMENTS.FEATURE_ADVANCED)
  advanced(@CurrentUser() user: AuthenticatedPrincipal): {
    ok: true;
    userId: string;
  } {
    return { ok: true, userId: user.id };
  }

  @Get('pro-only')
  @RequirePlan(PLAN_SLUGS.PRO)
  proOnly(@CurrentUser() user: AuthenticatedPrincipal): {
    ok: true;
    userId: string;
  } {
    return { ok: true, userId: user.id };
  }

  @Get('advanced-metered')
  @RequireEntitlement(ENTITLEMENTS.FEATURE_ADVANCED)
  @UsageLimit(USAGE_FEATURES.DEMO)
  advancedMetered(@CurrentUser() user: AuthenticatedPrincipal): {
    ok: true;
    userId: string;
  } {
    return { ok: true, userId: user.id };
  }
}

@Module({ controllers: [PlansFixtureController] })
export class PlansFixtureModule {}
