import { SetMetadata } from '@nestjs/common';

import type { Entitlement, PlanSlug } from './entitlements';

export const REQUIRED_ENTITLEMENTS_KEY = 'plans:entitlements';
export const REQUIRED_PLAN_KEY = 'plans:minimum';

/**
 * Requires **every** listed entitlement to be enabled on the caller's
 * effective plan. Typed against the code-declared catalogue.
 */
export const RequireEntitlement = (
  ...entitlements: [Entitlement, ...Entitlement[]]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ENTITLEMENTS_KEY, entitlements);

/**
 * Requires the caller's effective plan rank to be at least that of `slug`
 * (Lite < Pro < Enterprise).
 */
export const RequirePlan = (slug: PlanSlug): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PLAN_KEY, slug);
