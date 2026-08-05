import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
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

    /**
     * Both events carry a `Checkout.Session` and both mean "this session's money
     * is (now) settled", so they share one grant path.
     *
     * `async_payment_succeeded` is not optional extra credit: with settlement now
     * enforced in `hasSettled`, a delayed-notification payment grants nothing at
     * completion, so without this event it would never grant at all — trading
     * over-granting for silent non-delivery to a customer who has paid. The
     * canonical `stripe:checkout:{session.id}` key means whichever event arrives
     * first grants and the other is an idempotent no-op.
     *
     * **Operational precondition the code cannot enforce:** the Stripe endpoint
     * must be subscribed to `checkout.session.async_payment_succeeded`. If it is
     * not, this path is correct and never runs. See the webhook setup notes in
     * README.md.
     */
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      await this.grantFromCheckout(event.data.object);
    }

    /**
     * Keyed on `event.id`, so the two deliveries are recorded separately — they
     * are different events. Converging them on a single grant is the ledger's job
     * via the canonical key, not this table's.
     */
    await this.prisma.stripeProcessedEvent.create({
      data: { eventId: event.id, type: event.type },
    });

    return { received: true };
  }

  /**
   * Whether this session's money has actually settled.
   *
   * A positive test on the one field that describes payment, replacing a negative
   * two-clause condition that could not fire:
   *
   *     if (session.payment_status !== 'paid' && session.status !== 'complete')
   *
   * The events that reach here carry `status: 'complete'` by definition — that is
   * what "completed" means — so the second operand was always false, the `&&`
   * short-circuited, and the early return was unreachable. Every completed
   * session was credited regardless of payment, including the `unpaid` sessions
   * that delayed-notification methods produce.
   *
   * Note this is not `||` with the operands corrected: reasoning negatively over
   * two independent facts is what produced the bug, and one positive test on
   * `payment_status` has no such failure mode. **Do not "simplify" it back.**
   *
   * `no_payment_required` grants deliberately. A fully discounted pack (a 100%
   * coupon) settles nothing and must still deliver — withholding there would be
   * the same class of bug pointed the other way.
   */
  private hasSettled(session: Stripe.Checkout.Session): boolean {
    return (
      session.payment_status === 'paid' ||
      session.payment_status === 'no_payment_required'
    );
  }

  private async grantFromCheckout(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    if (!this.hasSettled(session)) {
      /**
       * Not an error: a session may legitimately complete before its payment
       * settles, and `checkout.session.async_payment_succeeded` grants later.
       * Logged so "the customer says they paid and has no credits" is
       * distinguishable from "no event ever arrived".
       */
      this.logger.warn({
        msg: 'Checkout session has not settled; no credits granted',
        sessionId: session.id,
        paymentStatus: session.payment_status,
        status: session.status,
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
