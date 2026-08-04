import { Injectable } from '@nestjs/common';

import type { MailMessage } from './mailer.service';

export interface RecordedMail extends MailMessage {
  recordedAt: Date;
}

/** Keeps memory bounded in a long-running process; ample for any test. */
const MAX_RECORDED = 50;

/**
 * In-memory record of messages the log transport "sent".
 *
 * A provider of its own rather than state inside the log adapter, so tests
 * inject it directly instead of casting the `MailerService` token to a concrete
 * class. Under the SMTP transport nothing writes to it and it stays empty.
 *
 * Full message bodies are retained here — including verification and reset
 * links, which is the point, since that is how an end-to-end test completes a
 * flow without an SMTP server. Bodies are never written to the log stream.
 */
@Injectable()
export class MailRecorder {
  private readonly messages: RecordedMail[] = [];

  record(message: MailMessage): void {
    this.messages.push({ ...message, recordedAt: new Date() });

    while (this.messages.length > MAX_RECORDED) {
      this.messages.shift();
    }
  }

  /** Newest last. */
  all(): readonly RecordedMail[] {
    return [...this.messages];
  }

  /** The most recent message sent to `to`, if any. */
  lastTo(to: string): RecordedMail | undefined {
    return [...this.messages]
      .reverse()
      .find((message) => message.to.toLowerCase() === to.toLowerCase());
  }

  /** First URL in the most recent message to `to` — the verification/reset link. */
  lastLinkTo(to: string): string | undefined {
    return /https?:\/\/\S+/.exec(this.lastTo(to)?.text ?? '')?.[0];
  }

  clear(): void {
    this.messages.length = 0;
  }

  get size(): number {
    return this.messages.length;
  }
}
