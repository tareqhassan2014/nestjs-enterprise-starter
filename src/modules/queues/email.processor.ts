import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from '@config/queues.config';
import { MailerService } from '@infrastructure/mail/mailer.service';
import type { MailMessage } from '@infrastructure/mail/mailer.service';

/**
 * Fixed rather than read from `BULLMQ_EMAIL_CONCURRENCY`: `@Processor()`'s
 * options are evaluated at class-decoration time, which runs while Node
 * resolves `QueuesModule`'s imports — before `ConfigModule.forRoot` loads
 * `.env` in `AppModule`'s own decorator (see `QueuesModule`). Calling
 * `getEnv()` here would validate raw `process.env` before the `.env` file is
 * merged in, breaking local dev. Forks that need this concurrency runtime
 * configurable should register the queue with `BullModule.registerQueueAsync`
 * and a `processors` callback instead, which resolves after config is ready.
 */
const EMAIL_WORKER_CONCURRENCY = 5;

/** Delivers queued mail through the existing `MailerService` port. */
@Processor(QUEUE_NAMES.EMAIL, { concurrency: EMAIL_WORKER_CONCURRENCY })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly mailer: MailerService) {
    super();
  }

  async process(job: Job<MailMessage>): Promise<void> {
    await this.mailer.send(job.data);
    this.logger.debug({
      msg: 'Email job delivered',
      jobId: job.id,
      to: job.data.to,
    });
  }
}
