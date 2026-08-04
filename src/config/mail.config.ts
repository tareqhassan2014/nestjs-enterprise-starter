import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

export const mailConfig = registerAs('mail', () => {
  const env = getEnv();

  return {
    /**
     * `log` records messages instead of delivering them. The schema rejects it
     * in production, so this can only be `log` where nobody is waiting on a
     * real message.
     */
    transport: env.MAIL_TRANSPORT,
    from: env.MAIL_FROM,

    /**
     * Present as a complete group whenever `transport` is `smtp` — the schema
     * enforces that, so consumers need no per-field fallbacks.
     */
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      secure: env.SMTP_SECURE,
    },
  };
});

export type MailConfig = ReturnType<typeof mailConfig>;
