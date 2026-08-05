import { Module } from '@nestjs/common';

import { CreditsModule } from '@modules/credits/credits.module';
import { PlansModule } from '@modules/plans/plans.module';
import { UsageLimitsModule } from '@modules/usage-limits/usage-limits.module';

import { AdminAuditController } from './admin-audit.controller';
import { AdminBillingController } from './admin-billing.controller';
import { AdminUsageController } from './admin-usage.controller';
import { AuditLogService } from './audit-log.service';
import { RateLimitObservationsService } from './rate-limit-observations.service';

@Module({
  imports: [CreditsModule, PlansModule, UsageLimitsModule],
  controllers: [
    AdminUsageController,
    AdminBillingController,
    AdminAuditController,
  ],
  providers: [AuditLogService, RateLimitObservationsService],
  exports: [AuditLogService, RateLimitObservationsService],
})
export class AdminModule {}
