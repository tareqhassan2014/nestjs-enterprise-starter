import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { NoEnvelope } from '@common/decorators/no-envelope.decorator';
import { Public } from '@modules/auth/auth.decorators';

import { StripeTopupService } from './stripe-topup.service';

/**
 * Stripe webhook — outside the success envelope (like Better Auth).
 * Raw body is required for signature verification; see AppModule middleware.
 * Intentionally has no session / API-key OpenAPI security.
 */
@ApiTags('Public')
@Controller({ path: 'billing', version: '1' })
export class BillingWebhookController {
  constructor(private readonly topup: StripeTopupService) {}

  @Public()
  @NoEnvelope()
  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw =
      req.rawBody ??
      (Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(JSON.stringify(req.body ?? {})));

    return this.topup.handleWebhook(raw, signature);
  }
}
