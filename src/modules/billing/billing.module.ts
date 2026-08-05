import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Stripe from 'stripe';

import { stripeConfig } from '@config/stripe.config';

import { BillingCheckoutController } from './billing-checkout.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { StripeTopupService } from './stripe-topup.service';
import { STRIPE_CLIENT } from './stripe.tokens';

@Module({
  controllers: [BillingCheckoutController, BillingWebhookController],
  providers: [
    {
      provide: STRIPE_CLIENT,
      inject: [stripeConfig.KEY],
      useFactory: (cfg: ConfigType<typeof stripeConfig>): Stripe | null => {
        if (!cfg.enabled || !cfg.secretKey) {
          return null;
        }

        return new Stripe(cfg.secretKey, {
          apiVersion: cfg.apiVersion,
          typescript: true,
        });
      },
    },
    StripeTopupService,
  ],
  exports: [StripeTopupService],
})
export class BillingModule {}
