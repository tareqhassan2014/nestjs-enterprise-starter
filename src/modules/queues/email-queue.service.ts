import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { QUEUE_NAMES } from '@config/queues.config';
import type { MailMessage } from '@infrastructure/mail/mailer.service';

/**
 * Non-critical mail goes through here instead of `MailerService` directly,
 * so a slow or failing provider cannot block the request that triggered it
 * (e.g. the low-balance bridge). Auth flows that must fail visibly on send
 * (verification, reset) keep calling `MailerService` synchronously — see
 * design.md decision 1.
 */
@Injectable()
export class EmailQueueService {
  constructor(
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly queue: Queue<MailMessage>,
  ) {}

  async enqueueEmail(message: MailMessage): Promise<void> {
    await this.queue.add('send', message);
  }
}
