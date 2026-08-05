import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';

import { CreditService } from './credit.service';

@Controller({ path: 'billing/credits', version: '1' })
export class CreditsController {
  constructor(private readonly credits: CreditService) {}

  @Get()
  async balance(
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<{ balance: number }> {
    const balance = await this.credits.getBalance(user.id);
    return { balance };
  }

  @Get('ledger')
  async ledger(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query('limit') limitRaw?: string,
  ): Promise<{
    entries: Array<{
      id: string;
      type: string;
      amount: number;
      balanceAfter: number;
      feature: string | null;
      createdAt: Date;
    }>;
  }> {
    const limit = limitRaw ? Number(limitRaw) : 20;
    const entries = await this.credits.listLedger(
      user.id,
      Number.isFinite(limit) ? limit : 20,
    );

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        feature: entry.feature,
        createdAt: entry.createdAt,
      })),
    };
  }
}
