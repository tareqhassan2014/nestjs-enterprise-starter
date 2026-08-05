import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Stripe from 'stripe';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { stripeConfig } from '@config/stripe.config';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { CreditService } from '@modules/credits/credit.service';

import { STRIPE_CLIENT } from './stripe.tokens';

@Injectable()
export class StripeTopupService {
  private readonly logger = new Logger(StripeTopupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditService,
    @Inject(stripeConfig.KEY)
    private readonly stripeCfg: ConfigType<typeof stripeConfig>,
    @Inject(STRIPE_CLIENT)
    private readonly stripe: Stripe | null,
  ) {}

  assertEnabled(): void {
    if (!this.stripeCfg.enabled || !this.stripe) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'Stripe top-up is not configured.',
      );
    }
  }

  async createCheckoutSession(params: {
    userId: string;
    email: string;
    packSlug: string;
  }): Promise<{ checkoutUrl: string; sessionId: string }> {
    this.assertEnabled();
    const stripe = this.stripe!;
    const pack = this.stripeCfg.packsBySlug[params.packSlug];

    if (!pack) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Unknown credit pack.',
        { pack: params.packSlug },
      );
    }

    const customerId = await this.getOrCreateCustomer(
      params.userId,
      params.email,
    );

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: params.userId,
      line_items: [{ price: pack.priceId, quantity: 1 }],
      success_url: this.stripeCfg.successUrl!,
      cancel_url: this.stripeCfg.cancelUrl!,
      metadata: {
        userId: params.userId,
        creditPack: pack.slug,
        credits: String(pack.credits),
      },
    });

    if (!session.url) {
      throw new ApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        'Stripe did not return a Checkout URL.',
      );
    }

    return { checkoutUrl: session.url, sessionId: session.id };
  }

  async handleWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ received: true }> {
    this.assertEnabled();
    const stripe = this.stripe!;

    if (!signature) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Missing Stripe-Signature header.',
      );
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.stripeCfg.webhookSecret!,
      );
    } catch (error) {
      this.logger.warn({
        msg: 'Stripe webhook signature verification failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'Invalid Stripe webhook signature.',
      );
    }

    const already = await this.prisma.stripeProcessedEvent.findUnique({
      where: { eventId: event.id },
    });
    if (already) {
      return { received: true };
    }

    if (event.type === 'checkout.session.completed') {
      await this.grantFromCheckout(event.data.object as Stripe.Checkout.Session);
    }

    await this.prisma.stripeProcessedEvent.create({
      data: { eventId: event.id, type: event.type },
    });

    return { received: true };
  }

  private async grantFromCheckout(session: Stripe.Checkout.Session): Promise<void> {
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      this.logger.warn({
        msg: 'Ignoring unpaid Checkout session',
        sessionId: session.id,
        paymentStatus: session.payment_status,
      });
      return;
    }

    const packSlug = session.metadata?.creditPack;
    const userId =
      session.metadata?.userId ?? session.client_reference_id ?? undefined;

    if (!userId || !packSlug) {
      this.logger.error({
        msg: 'Checkout session missing userId or creditPack metadata',
        sessionId: session.id,
      });
      return;
    }

    const pack = this.stripeCfg.packsBySlug[packSlug];
    if (!pack) {
      this.logger.error({
        msg: 'Checkout session references unknown pack',
        sessionId: session.id,
        packSlug,
      });
      return;
    }

    // Server-side pack map is authoritative — ignore client-tampered metadata credits.
    await this.credits.grant({
      userId,
      amount: pack.credits,
      idempotencyKey: `stripe:checkout:${session.id}`,
      metadata: {
        source: 'stripe_checkout',
        sessionId: session.id,
        creditPack: pack.slug,
        priceId: pack.priceId,
      },
    });
  }

  private async getOrCreateCustomer(
    userId: string,
    email: string,
  ): Promise<string> {
    const existing = await this.prisma.stripeCustomer.findUnique({
      where: { userId },
    });
    if (existing) {
      return existing.stripeCustomerId;
    }

    const customer = await this.stripe!.customers.create({
      email,
      metadata: { userId },
    });

    await this.prisma.stripeCustomer.create({
      data: { userId, stripeCustomerId: customer.id },
    });

    return customer.id;
  }
}
