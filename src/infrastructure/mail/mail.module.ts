import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { mailConfig } from '@config/mail.config';

import { LogMailerService } from './log-mailer.service';
import { MailRecorder } from './mail-recorder';
import { MailerService } from './mailer.service';
import { SmtpMailerService } from './smtp-mailer.service';

/**
 * Binds the `MailerService` port to the adapter the configured transport
 * selects. Consumers inject the port and never learn which one they got.
 *
 * `MailRecorder` is always provided so tests can inject it without knowing the
 * transport; under SMTP nothing writes to it.
 */
@Global()
@Module({
  providers: [
    MailRecorder,
    {
      provide: MailerService,
      inject: [mailConfig.KEY, MailRecorder],
      useFactory: (
        config: ConfigType<typeof mailConfig>,
        recorder: MailRecorder,
      ): MailerService =>
        config.transport === 'smtp'
          ? new SmtpMailerService(config)
          : new LogMailerService(recorder),
    },
  ],
  exports: [MailerService, MailRecorder],
})
export class MailModule {}
