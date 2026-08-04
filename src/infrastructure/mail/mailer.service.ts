/** A message to send. Deliberately provider-neutral — see `MailerService`. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * The only way application code sends mail.
 *
 * An abstract class rather than an interface so it doubles as the DI token:
 * consumers inject `MailerService` and receive whichever adapter the configured
 * transport selected, with no provider-specific concept reaching them. Swapping
 * to Resend or SES means writing one adapter and changing `MAIL_TRANSPORT`.
 *
 * Implementations MUST NOT swallow a delivery failure — see the
 * `transactional-email` capability.
 */
export abstract class MailerService {
  abstract send(message: MailMessage): Promise<void>;
}
