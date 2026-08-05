import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { BillingPlanController } from './billing-plan.controller';
import { EntitlementsGuard } from './entitlements.guard';
import { PlanResolutionService } from './plan-resolution.service';

/**
 * Commercial plans and the entitlements gate.
 *
 * `APP_GUARD` registration order is the contract: this module must be imported
 * in `AppModule` **after** `AuthorizationModule` and **before**
 * `ThrottlingModule` / `UsageLimitsModule` so the chain is:
 *
 *   Auth → Permissions → Entitlements → Throttle → Usage → Credits
 */
@Global()
@Module({
  controllers: [BillingPlanController],
  providers: [
    PlanResolutionService,
    { provide: APP_GUARD, useClass: EntitlementsGuard },
  ],
  exports: [PlanResolutionService],
})
export class PlansModule {}
