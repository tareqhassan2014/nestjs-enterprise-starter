import { Global, Module } from '@nestjs/common';

import { FeatureFlagsService } from './feature-flags.service';

/**
 * Global so any module can resolve a flag without importing this one
 * explicitly — mirrors `AuthorizationModule` / `PlansModule`.
 */
@Global()
@Module({
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
