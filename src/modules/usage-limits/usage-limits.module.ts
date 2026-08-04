import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { UsageLimitsGuard } from './usage-limits.guard';
import { UsageLimitsService } from './usage-limits.service';

/**
 * Daily/weekly usage counters. `APP_GUARD` must be imported after
 * `ThrottlingModule` so the chain is Auth → Permissions → Throttle → Usage.
 */
@Global()
@Module({
  providers: [
    UsageLimitsService,
    { provide: APP_GUARD, useClass: UsageLimitsGuard },
  ],
  exports: [UsageLimitsService],
})
export class UsageLimitsModule {}
