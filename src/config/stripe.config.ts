import { registerAs } from '@nestjs/config';

import { parseStripeCreditPacks } from './env.schema';
import { getEnv } from './env.validation';

/**
 * Stripe Checkout top-up. Enabled only when the credential group is complete —
 * never via a separate enable flag.
 *
 * API version is pinned to the SDK default (`2026-07-29.dahlia` for stripe@22).
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia' as const;

export interface StripeCreditPack {
  slug: string;
  credits: number;
  priceId: string;
}

export const stripeConfig = registerAs('stripe', () => {
  const env = getEnv();

  const enabled = Boolean(
    env.STRIPE_SECRET_KEY &&
    env.STRIPE_WEBHOOK_SECRET &&
    env.STRIPE_CREDIT_PACKS,
  );

  if (!enabled) {
    // Annotated locals, not `as` assertions: the disabled branch must publish
    // the same pack types as the enabled one, or callers indexing
    // `packsBySlug` hit an implicit `any` on the union.
    const packs: StripeCreditPack[] = [];
    const packsBySlug: Record<string, StripeCreditPack> = {};

    return {
      enabled: false as const,
      secretKey: undefined,
      webhookSecret: undefined,
      packs,
      packsBySlug,
      successUrl: undefined,
      cancelUrl: undefined,
      apiVersion: STRIPE_API_VERSION,
      lowBalanceThreshold: env.CREDITS_LOW_BALANCE_THRESHOLD,
    };
  }

  const packs = parseStripeCreditPacks(env.STRIPE_CREDIT_PACKS!);
  const packsBySlug = Object.fromEntries(
    packs.map((pack) => [pack.slug, pack]),
  );

  return {
    enabled: true as const,
    secretKey: env.STRIPE_SECRET_KEY!,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
    packs,
    packsBySlug,
    successUrl: env.STRIPE_SUCCESS_URL ?? `${env.APP_URL}/billing/success`,
    cancelUrl: env.STRIPE_CANCEL_URL ?? `${env.APP_URL}/billing/cancel`,
    apiVersion: STRIPE_API_VERSION,
    lowBalanceThreshold: env.CREDITS_LOW_BALANCE_THRESHOLD,
  };
});

export type StripeConfig = ReturnType<typeof stripeConfig>;
