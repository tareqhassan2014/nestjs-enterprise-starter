import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';

import { queuesConfig } from '@config/queues.config';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import {
  CREDITS_LOW_BALANCE_EVENT,
  type CreditsLowBalancePayload,
} from '@modules/credits/credit.service';
import { FEATURE_FLAGS } from '@modules/feature-flags/feature-flags.catalogue';
import { FeatureFlagsService } from '@modules/feature-flags/feature-flags.service';

import { EmailQueueService } from './email-queue.service';

/**
 * Bridges `CREDITS_LOW_BALANCE_EVENT` to the `email` queue, fulfilling the
 * hook the credits capability deferred (design.md decision 8). Enqueues
 * rather than sending synchronously so a slow mail provider never blocks the
 * spend that crossed the threshold.
 *
 * Enabled when *either* the `email.low_balance` feature flag or the
 * `EMAIL_LOW_BALANCE_ENABLED` config toggle is on — the flag allows a
 * per-user/org override; the env var is a blunt global switch for forks that
 * don't want to touch `FeatureFlagOverride` rows at all.
 */
@Injectable()
export class LowBalanceEmailListener {
  private readonly logger = new Logger(LowBalanceEmailListener.name);

  constructor(
    private readonly featureFlags: FeatureFlagsService,
    private readonly emailQueue: EmailQueueService,
    private readonly prisma: PrismaService,
    @Inject(queuesConfig.KEY)
    private readonly queues: ConfigType<typeof queuesConfig>,
  ) {}

  @OnEvent(CREDITS_LOW_BALANCE_EVENT)
  async handle(payload: CreditsLowBalancePayload): Promise<void> {
    const flagEnabled = await this.featureFlags.isEnabled(
      FEATURE_FLAGS.EMAIL_LOW_BALANCE,
      {
        userId:
          payload.subject.type === 'user' ? payload.subject.userId : undefined,
        organizationId:
          payload.subject.type === 'organization'
            ? payload.subject.organizationId
            : undefined,
      },
    );

    if (!flagEnabled && !this.queues.emailLowBalanceEnabled) {
      return;
    }

    const recipient = await this.resolveRecipient(payload);
    if (!recipient) {
      this.logger.warn({
        msg: 'No recipient resolved for low-balance email',
        subject: payload.subject,
      });
      return;
    }

    await this.emailQueue.enqueueEmail({
      to: recipient,
      subject: 'Your credit balance is low',
      text: `Your balance is now ${payload.balance}, at or below your configured threshold of ${payload.threshold}. Top up to avoid interruptions.`,
    });
  }

  private async resolveRecipient(
    payload: CreditsLowBalancePayload,
  ): Promise<string | undefined> {
    if (payload.subject.type === 'user') {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.subject.userId },
        select: { email: true },
      });
      return user?.email;
    }

    // Organizations have no dedicated billing-contact concept yet (see
    // design.md non-goals) — the owner is the closest stand-in.
    const owner = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: payload.subject.organizationId,
        role: 'owner',
      },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true } } },
    });
    return owner?.user.email;
  }
}
