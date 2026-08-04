import { Controller, Get, Module } from '@nestjs/common';

import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import { USAGE_FEATURES } from '@modules/usage-limits/usage-features';
import { UsageLimit } from '@modules/usage-limits/usage-limit.decorator';

/**
 * Authenticated metered route for e2e only — exercises `@UsageLimit` without
 * polluting the product API surface.
 */
@Controller({ path: 'fixture', version: '1' })
export class UsageFixtureController {
  @Get('metered')
  @UsageLimit(USAGE_FEATURES.DEMO)
  metered(@CurrentUser() user: AuthenticatedPrincipal): {
    ok: true;
    userId: string;
  } {
    return { ok: true, userId: user.id };
  }
}

@Module({ controllers: [UsageFixtureController] })
export class UsageFixtureModule {}
