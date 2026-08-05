import { Body, Controller, HttpStatus, Post } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { StripeTopupService } from './stripe-topup.service';

class CreateCheckoutDto {
  @IsString()
  @MinLength(1)
  pack!: string;
}

@Controller({ path: 'billing', version: '1' })
export class BillingCheckoutController {
  constructor(private readonly topup: StripeTopupService) {}

  @Post('checkout')
  async createCheckout(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: CreateCheckoutDto,
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    if (!body?.pack) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'pack is required.',
      );
    }

    return this.topup.createCheckoutSession({
      userId: user.id,
      email: user.email,
      packSlug: body.pack,
    });
  }
}
