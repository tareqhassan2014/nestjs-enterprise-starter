import { Injectable, Logger } from '@nestjs/common';

import { RequestContext } from '@common/context/request-context';

import { MailRecorder } from './mail-recorder';
import { type MailMessage, MailerService } from './mailer.service';

/**
 * Records messages instead of delivering them. For development and tests only —
 * the environment schema rejects this transport under `NODE_ENV=production`,
 * because it would make sign-up appear to succeed while every verification and
 * reset message silently vanished.
 *
 * Logs the recipient and subject but never the body: bodies carry verification
 * and reset tokens, and a token in the log stream is a token in whatever
 * aggregates it. The full body goes to `MailRecorder`, which is in-memory and
 * test-facing.
 */
@Injectable()
export class LogMailerService extends MailerService {
  private readonly logger = new Logger(LogMailerService.name);

  constructor(private readonly recorder: MailRecorder) {
    super();
  }

  send(message: MailMessage): Promise<void> {
    this.recorder.record(message);

    this.logger.log({
      msg: 'Mail recorded (log transport — not delivered)',
      to: message.to,
      subject: message.subject,
      requestId: RequestContext.getRequestId(),
    });

    return Promise.resolve();
  }
}
