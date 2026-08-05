import { SetMetadata } from '@nestjs/common';

import type { CreditFeature } from './credit-costs';

export const COSTS_CREDITS_KEY = 'costsCredits';

/**
 * Debits the caller's wallet by the catalogue cost for `feature` before the
 * handler runs (CreditsGuard). Compensating refund on handler failure is
 * handled by CreditsRefundInterceptor.
 */
export const CostsCredits = (feature: CreditFeature) =>
  SetMetadata(COSTS_CREDITS_KEY, feature);
