import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { BillingSubjectResolver } from './billing-subject.resolver';
import { OrganizationContextGuard } from './organization-context.guard';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

/**
 * Organizations, membership, and the billing-subject resolver.
 *
 * Global so `OrganizationsService` / `BillingSubjectResolver` are available
 * to `CreditsModule` and `PlansModule` without an explicit import — mirrors
 * `PlansModule` / `UsageLimitsModule`.
 *
 * Import in `AppModule` **after** `AuthorizationModule` and **before**
 * `PlansModule` / `ThrottlingModule` / `UsageLimitsModule` / `CreditsModule`,
 * so `OrganizationContextGuard` runs early enough to bind the org before any
 * of those resolve a billing subject, without itself gating on plan/throttle/
 * usage/credits:
 *
 *   Auth → Permissions → Org context → Entitlements → Throttle → Usage → Credits
 */
@Global()
@Module({
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    BillingSubjectResolver,
    { provide: APP_GUARD, useClass: OrganizationContextGuard },
  ],
  exports: [OrganizationsService, BillingSubjectResolver],
})
export class OrganizationsModule {}
