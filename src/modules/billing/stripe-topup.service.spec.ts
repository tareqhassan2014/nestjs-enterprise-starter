import { HttpStatus } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Stripe from 'stripe';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import type { stripeConfig } from '@config/stripe.config';
import type { PrismaService } from '@infrastructure/prisma/prisma.service';
import type { CreditService } from '@modules/credits/credit.service';

import { StripeTopupService } from './stripe-topup.service';

const enabledCfg = {
  enabled: true,
  secretKey: 'sk_test_x',
  webhookSecret: 'whsec_test',
  packs: [{ slug: 'starter', credits: 100, priceId: 'price_starter' }],
  packsBySlug: {
    starter: { slug: 'starter', credits: 100, priceId: 'price_starter' },
  },
  successUrl: 'http://localhost:3000/billing/success',
  cancelUrl: 'http://localhost:3000/billing/cancel',
  apiVersion: '2026-07-29.dahlia',
  lowBalanceThreshold: undefined,
} as ConfigType<typeof stripeConfig>;

const disabledCfg = {
  ...enabledCfg,
  enabled: false,
  secretKey: undefined,
  webhookSecret: undefined,
  packs: [],
  packsBySlug: {},
} as ConfigType<typeof stripeConfig>;

describe('StripeTopupService', () => {
  it('fails closed when Stripe is disabled', async () => {
    const service = new StripeTopupService(
      {} as PrismaService,
      {} as CreditService,
      disabledCfg,
      null,
    );

    await expect(
      service.createCheckoutSession({
        userId: 'u1',
        email: 'a@b.co',
        packSlug: 'starter',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: ErrorCode.SERVICE_UNAVAILABLE,
    });
  });

  it('rejects unknown packs', async () => {
    const stripe = {
      customers: { create: jest.fn() },
      checkout: { sessions: { create: jest.fn() } },
      webhooks: { constructEvent: jest.fn() },
    } as unknown as Stripe;

    const prisma = {
      stripeCustomer: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    const service = new StripeTopupService(
      prisma,
      {} as CreditService,
      enabledCfg,
      stripe,
    );

    await expect(
      service.createCheckoutSession({
        userId: 'u1',
        email: 'a@b.co',
        packSlug: 'nope',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('rejects invalid webhook signatures', async () => {
    const stripe = {
      webhooks: {
        constructEvent: jest.fn(() => {
          throw new Error('bad sig');
        }),
      },
    } as unknown as Stripe;

    const service = new StripeTopupService(
      {} as PrismaService,
      {} as CreditService,
      enabledCfg,
      stripe,
    );

    await expect(
      service.handleWebhook(Buffer.from('{}'), 'sig'),
    ).rejects.toBeInstanceOf(ApiException);
  });

  it('grants once for a paid checkout and ignores duplicates', async () => {
    const grant = jest.fn().mockResolvedValue({});
    const credits = { grant } as unknown as CreditService;

    const processed = new Map<string, boolean>();
    const prisma = {
      stripeProcessedEvent: {
        findUnique: jest.fn(async ({ where }: { where: { eventId: string } }) =>
          processed.has(where.eventId) ? { eventId: where.eventId } : null,
        ),
        create: jest.fn(async ({ data }: { data: { eventId: string } }) => {
          processed.set(data.eventId, true);
          return data;
        }),
      },
    } as unknown as PrismaService;

    const session = {
      id: 'cs_1',
      payment_status: 'paid',
      status: 'complete',
      metadata: { userId: 'u1', creditPack: 'starter', credits: '999' },
      client_reference_id: 'u1',
    };

    const stripe = {
      webhooks: {
        constructEvent: jest.fn(() => ({
          id: 'evt_1',
          type: 'checkout.session.completed',
          data: { object: session },
        })),
      },
    } as unknown as Stripe;

    const service = new StripeTopupService(
      prisma,
      credits,
      enabledCfg,
      stripe,
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');
    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        amount: 100,
        idempotencyKey: 'stripe:checkout:cs_1',
      }),
    );
  });
});
