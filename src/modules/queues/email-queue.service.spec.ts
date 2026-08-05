import type { Queue } from 'bullmq';

import type { MailMessage } from '@infrastructure/mail/mailer.service';

import { EmailQueueService } from './email-queue.service';

describe('EmailQueueService', () => {
  it('adds a send job with the message payload', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new EmailQueueService({
      add,
    } as unknown as Queue<MailMessage>);

    await service.enqueueEmail({
      to: 'a@b.co',
      subject: 'Hi',
      text: 'Hello',
    });

    expect(add).toHaveBeenCalledWith('send', {
      to: 'a@b.co',
      subject: 'Hi',
      text: 'Hello',
    });
  });
});
