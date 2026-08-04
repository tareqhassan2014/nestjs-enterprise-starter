import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import { RequestContext } from '@common/context/request-context';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import type { mailConfig } from '@config/mail.config';

import { type MailMessage, MailerService } from './mailer.service';

/**
 * Delivers over SMTP.
 *
 * SMTP rather than a hosted provider's SDK because it is the one transport every
 * provider speaks, which keeps the template vendor-neutral.
 *
 * A failure is logged at `error` with the request id and rethrown. It is
 * deliberately not swallowed: a sign-up whose verification mail failed leaves a
 * real but unverified user, and the client needs to know so it can prompt a
 * resend. Reporting success would leave an account nobody can reach.
 */
@Injectable()
export class SmtpMailerService extends MailerService {
  private readonly logger = new Logger(SmtpMailerService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigType<typeof mailConfig>) {
    super();

    this.from = config.from;

    // The schema guarantees the whole SMTP group is present for this transport,
    // so there is nothing to fall back to here.
    this.transporter = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.password,
      },
    });
  }

  async send(message: MailMessage): Promise<void> {
    const requestId = RequestContext.getRequestId();

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });

      this.logger.log({
        msg: 'Mail sent',
        to: message.to,
        subject: message.subject,
        requestId,
      });
    } catch (error: unknown) {
      // The recipient and subject are safe to log; the body is not — it carries
      // the verification or reset token.
      this.logger.error(
        {
          msg: 'Mail delivery failed',
          to: message.to,
          subject: message.subject,
          requestId,
          reason: error instanceof Error ? error.message : String(error),
        },
        error instanceof Error ? error.stack : undefined,
      );

      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'Could not send the message. Please try again.',
      );
    }
  }
}
