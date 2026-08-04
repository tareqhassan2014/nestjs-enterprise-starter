import { Logger } from '@nestjs/common';

import { LogMailerService } from './log-mailer.service';
import { MailRecorder } from './mail-recorder';
import { SmtpMailerService } from './smtp-mailer.service';

const VERIFICATION = {
  to: 'ada@example.com',
  subject: 'Verify your email',
  text: 'Confirm here: http://localhost:3000/api/auth/verify-email?token=tok_secret_123',
};

// Silenced by default so the suite output stays readable; the cases that assert
// on log content install their own capturing implementation over these.
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('LogMailerService', () => {
  let recorder: MailRecorder;
  let mailer: LogMailerService;

  beforeEach(() => {
    recorder = new MailRecorder();
    mailer = new LogMailerService(recorder);
  });

  it('records a message without attempting delivery', async () => {
    await mailer.send(VERIFICATION);

    expect(recorder.size).toBe(1);
    expect(recorder.lastTo('ada@example.com')?.subject).toBe(
      'Verify your email',
    );
  });

  it('exposes the link from the most recent message, so tests can complete a flow', async () => {
    await mailer.send(VERIFICATION);

    expect(recorder.lastLinkTo('ada@example.com')).toBe(
      'http://localhost:3000/api/auth/verify-email?token=tok_secret_123',
    );
  });

  it('matches the recipient case-insensitively', async () => {
    await mailer.send(VERIFICATION);

    expect(recorder.lastTo('ADA@Example.com')).toBeDefined();
  });

  it('returns the newest message when several went to one recipient', async () => {
    await mailer.send({ ...VERIFICATION, subject: 'first' });
    await mailer.send({ ...VERIFICATION, subject: 'second' });

    expect(recorder.lastTo('ada@example.com')?.subject).toBe('second');
  });

  it('logs the recipient and subject but never the body', async () => {
    const entries: unknown[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((entry: unknown) => {
      entries.push(entry);
    });

    await mailer.send(VERIFICATION);

    const serialized = JSON.stringify(entries);

    expect(serialized).toContain('ada@example.com');
    expect(serialized).toContain('Verify your email');
    // The token lives in the body; the body must not reach the log stream.
    expect(serialized).not.toContain('tok_secret_123');
  });

  it('keeps the token readable in memory while absent from the log', async () => {
    await mailer.send(VERIFICATION);

    expect(recorder.lastTo('ada@example.com')?.text).toContain(
      'tok_secret_123',
    );
  });
});

describe('MailRecorder', () => {
  it('discards the oldest messages beyond its retention limit', () => {
    const recorder = new MailRecorder();

    for (let index = 0; index < 120; index += 1) {
      recorder.record({ ...VERIFICATION, subject: `message-${index}` });
    }

    expect(recorder.size).toBe(50);

    const subjects = recorder.all().map((message) => message.subject);
    expect(subjects.at(-1)).toBe('message-119');
    expect(subjects).not.toContain('message-0');
  });

  it('starts empty and clears', () => {
    const recorder = new MailRecorder();
    recorder.record(VERIFICATION);
    recorder.clear();

    expect(recorder.size).toBe(0);
    expect(recorder.all()).toEqual([]);
  });
});

describe('SmtpMailerService', () => {
  const config = {
    transport: 'smtp' as const,
    from: 'no-reply@example.com',
    smtp: {
      host: 'smtp.example.com',
      port: 587,
      user: 'mailer',
      password: 'smtp-password-should-never-be-logged',
      secure: false,
    },
  };

  /** The nodemailer transport is built in the constructor; reach it to stub. */
  function stubTransport(mailer: SmtpMailerService) {
    const { transporter } = mailer as unknown as {
      transporter: { sendMail: (...args: unknown[]) => Promise<unknown> };
    };

    return jest.spyOn(transporter, 'sendMail');
  }

  it('propagates a delivery failure instead of swallowing it', async () => {
    const mailer = new SmtpMailerService(config);
    stubTransport(mailer).mockRejectedValue(new Error('connection refused'));

    await expect(mailer.send(VERIFICATION)).rejects.toThrow(
      /Could not send the message/,
    );
  });

  it('logs a failure at error level without leaking the body or the password', async () => {
    const entries: unknown[] = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((entry: unknown) => {
        entries.push(entry);
      });

    const mailer = new SmtpMailerService(config);
    stubTransport(mailer).mockRejectedValue(new Error('connection refused'));

    await expect(mailer.send(VERIFICATION)).rejects.toThrow();

    expect(entries).toHaveLength(1);

    const serialized = JSON.stringify(entries);
    expect(serialized).toContain('ada@example.com');
    expect(serialized).not.toContain('tok_secret_123');
    expect(serialized).not.toContain('smtp-password-should-never-be-logged');
  });

  it('reports success only when the transport accepted the message', async () => {
    const mailer = new SmtpMailerService(config);
    const sendMail = stubTransport(mailer).mockResolvedValue({
      accepted: [VERIFICATION.to],
    });

    await expect(mailer.send(VERIFICATION)).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
