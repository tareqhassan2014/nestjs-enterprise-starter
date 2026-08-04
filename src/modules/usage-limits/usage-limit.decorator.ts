import { SetMetadata } from '@nestjs/common';

import type { UsageFeature } from './usage-features';

export const USAGE_LIMIT_KEY = 'usage:limit';

/**
 * Meters every request to the route for the given feature (guard runs before
 * the handler). Prefer programmatic `UsageLimitsService.consume()` when only
 * successful billable work should burn quota.
 */
export const UsageLimit = (
  feature: UsageFeature,
): ClassDecorator & MethodDecorator => SetMetadata(USAGE_LIMIT_KEY, feature);
