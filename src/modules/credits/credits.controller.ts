import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import { BillingSubjectResolver } from '@modules/organizations/billing-subject.resolver';

import { CreditService } from './credit.service';

@Controller({ path: 'billing/credits', version: '1' })
export class CreditsController {
  constructor(
    private readonly credits: CreditService,
    private readonly billingSubjects: BillingSubjectResolver,
  ) {}

  @Get()
  async balance(
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<{ balance: number; subject: 'user' | 'organization' }> {
    const subject = await this.billingSubjects.resolve(user.id);
    const balance = await this.credits.getBalance(subject);
    return { balance, subject: subject.type };
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
    const subject = await this.billingSubjects.resolve(user.id);
    const limit = limitRaw ? Number(limitRaw) : 20;
    const entries = await this.credits.listLedger(
      subject,
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
