import { Controller, Module, Post } from '@nestjs/common';

import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import { CostsCredits } from '@modules/credits/credit.decorators';
import { ENTITLEMENTS } from '@modules/plans/entitlements';
import { RequireEntitlement } from '@modules/plans/plan.decorators';
import { USAGE_FEATURES } from '@modules/usage-limits/usage-features';
import { UsageLimit } from '@modules/usage-limits/usage-limit.decorator';

/**
 * Authenticated fixture routes for credits guard-order e2e — not product API.
 */
@Controller({ path: 'fixture', version: '1' })
export class CreditsFixtureController {
  @Post('usage-and-credits')
  @UsageLimit(USAGE_FEATURES.DEMO)
  @CostsCredits('demo.paid')
  usageAndCredits(@CurrentUser() user: AuthenticatedPrincipal): {
    ok: true;
    userId: string;
  } {
    return { ok: true, userId: user.id };
  }

  @Post('entitlement-and-credits')
  @RequireEntitlement(ENTITLEMENTS.FEATURE_ADVANCED)
  @CostsCredits('demo.paid')
  entitlementAndCredits(@CurrentUser() user: AuthenticatedPrincipal): {
    ok: true;
    userId: string;
  } {
    return { ok: true, userId: user.id };
  }
}

@Module({ controllers: [CreditsFixtureController] })
export class CreditsFixtureModule {}
