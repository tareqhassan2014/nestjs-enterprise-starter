import { Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSessionAuth } from '@infrastructure/openapi/api-session-auth.decorator';
import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { CostsCredits } from './credit.decorators';

/**
 * Copy-paste pattern for a billable route: decorate with `@CostsCredits` and
 * keep the handler free of side effects that must survive a compensating refund.
 */
@ApiTags('Account')
@ApiSessionAuth()
@Controller({ path: 'billing/demo', version: '1' })
export class CreditsDemoController {
  @Post('paid')
  @CostsCredits('demo.paid')
  paid(@CurrentUser() user: AuthenticatedPrincipal): {
    ok: true;
    userId: string;
    feature: 'demo.paid';
  } {
    return { ok: true, userId: user.id, feature: 'demo.paid' };
  }
}
