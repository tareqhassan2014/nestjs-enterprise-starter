import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { CreditsController } from './credits.controller';
import { CreditsDemoController } from './credits-demo.controller';
import { CreditsGuard } from './credits.guard';
import { CreditsRefundInterceptor } from './credits-refund.interceptor';
import { CreditService } from './credit.service';

/**
 * Credit wallet / ledger and the final guard-chain stage.
 *
 * Import in `AppModule` **after** `UsageLimitsModule` so Nest appends
 * `CreditsGuard` last:
 *
 *   Auth → Permissions → Entitlements → Throttle → Usage → Credits
 */
@Global()
@Module({
  controllers: [CreditsController, CreditsDemoController],
  providers: [
    CreditService,
    { provide: APP_GUARD, useClass: CreditsGuard },
    { provide: APP_INTERCEPTOR, useClass: CreditsRefundInterceptor },
  ],
  exports: [CreditService],
})
export class CreditsModule {}
