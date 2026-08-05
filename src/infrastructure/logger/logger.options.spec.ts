import type { IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';

import pino from 'pino';

import { RequestContext } from '@common/context/request-context';
import type { LoggerConfig } from '@config/logger.config';

import { buildLoggerParams } from './logger.options';

type PinoHttpOptions = {
  level: string;
  redact: pino.LoggerOptions['redact'];
  mixin: pino.LoggerOptions['mixin'];
  transport?: unknown;
  genReqId: (req: IncomingMessage) => string;
  autoLogging: { ignore: (req: IncomingMessage) => boolean };
};

function optionsFor(overrides: Partial<LoggerConfig> = {}): PinoHttpOptions {
  const config: LoggerConfig = {
    level: 'info',
    pretty: false,
    ...overrides,
  };

  return buildLoggerParams(config).pinoHttp as unknown as PinoHttpOptions;
}

/** A pino instance wired with the real options, writing to memory. */
function capture(overrides: Partial<LoggerConfig> = {}) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  const { level, redact, mixin } = optionsFor(overrides);
  const logger = pino({ level, redact, mixin }, stream);

  return { logger, lines };
}

describe('logger options', () => {
  it('emits one line of valid JSON per entry', () => {
    const { logger, lines } = capture();

    logger.info({ orderId: 'o-1' }, 'created');

    expect(lines).toHaveLength(1);
    expect(lines[0].trimEnd()).not.toContain('\n');
    expect(JSON.parse(lines[0])).toMatchObject({
      orderId: 'o-1',
      msg: 'created',
    });
  });

  it('never serialises an authorization header', () => {
    const { logger, lines } = capture();

    logger.info({
      req: { headers: { authorization: 'Bearer super-secret-token-value' } },
    });

    expect(lines[0]).not.toContain('super-secret-token-value');
    expect(lines[0]).toContain('[redacted]');
  });

  it('never serialises cookie headers in either direction', () => {
    const { logger, lines } = capture();

    logger.info({
      req: { headers: { cookie: 'session=abc123secret' } },
      res: { headers: { 'set-cookie': 'session=xyz789secret' } },
    });

    expect(lines[0]).not.toContain('abc123secret');
    expect(lines[0]).not.toContain('xyz789secret');
  });

  it('redacts sensitive keys at the top level and when nested', () => {
    const { logger, lines } = capture();

    logger.info({
      password: 'top-level-value',
      user: { token: 'nested-value' },
      outer: { inner: { apiKey: 'deep-value' } },
    });

    expect(lines[0]).not.toContain('top-level-value');
    expect(lines[0]).not.toContain('nested-value');
    expect(lines[0]).not.toContain('deep-value');
  });

  it('adds the request id to every line emitted inside a request scope', () => {
    const { logger, lines } = capture();

    RequestContext.run({ requestId: 'req-42' }, () => {
      logger.info('inside');
    });
    logger.info('outside');

    expect(JSON.parse(lines[0])).toMatchObject({ requestId: 'req-42' });
    expect(JSON.parse(lines[1])).not.toHaveProperty('requestId');
  });

  describe('actor attribution', () => {
    it('adds the authenticated user id once the guard has resolved it', () => {
      const { logger, lines } = capture();

      RequestContext.run({ requestId: 'req-1' }, () => {
        logger.info('before the guard');
        RequestContext.setUserId('user-7');
        logger.info('after the guard');
      });

      expect(JSON.parse(lines[0])).toMatchObject({ requestId: 'req-1' });
      expect(JSON.parse(lines[0])).not.toHaveProperty('userId');

      expect(JSON.parse(lines[1])).toMatchObject({
        requestId: 'req-1',
        userId: 'user-7',
      });
    });

    it('joins pre- and post-authentication entries by request id', () => {
      const { logger, lines } = capture();

      RequestContext.run({ requestId: 'req-join' }, () => {
        logger.info('early');
        RequestContext.setUserId('user-9');
        logger.info('late');
      });

      const [early, late] = lines.map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );

      expect(early.requestId).toBe(late.requestId);
      expect(late.userId).toBe('user-9');
    });

    it('carries no user id on an unauthenticated request', () => {
      const { logger, lines } = capture();

      RequestContext.run({ requestId: 'req-public' }, () => {
        logger.info('public route');
      });

      expect(JSON.parse(lines[0])).not.toHaveProperty('userId');
    });
  });

  describe('redaction of auth credentials', () => {
    it('redacts session and provider tokens wherever they appear', () => {
      const { logger, lines } = capture();

      logger.info({
        sessionToken: 'session-value-must-not-appear',
        account: { refreshToken: 'refresh-value-must-not-appear' },
        oauth: { provider: { clientSecret: 'client-secret-must-not-appear' } },
      });

      expect(lines[0]).not.toContain('session-value-must-not-appear');
      expect(lines[0]).not.toContain('refresh-value-must-not-appear');
      expect(lines[0]).not.toContain('client-secret-must-not-appear');
    });

    it('redacts two-factor material', () => {
      const { logger, lines } = capture();

      logger.info({
        totpCode: '123456',
        secret: 'provisioning-secret-must-not-appear',
        twoFactor: { backupCodes: 'backup-codes-must-not-appear' },
      });

      expect(lines[0]).not.toContain('provisioning-secret-must-not-appear');
      expect(lines[0]).not.toContain('backup-codes-must-not-appear');
      expect(lines[0]).not.toContain('123456');
    });

    it('redacts verification and reset tokens, and submitted passwords', () => {
      const { logger, lines } = capture();

      logger.info({
        token: 'verification-token-must-not-appear',
        body: { newPassword: 'new-password-must-not-appear' },
      });

      expect(lines[0]).not.toContain('verification-token-must-not-appear');
      expect(lines[0]).not.toContain('new-password-must-not-appear');
    });

    it('needs no cooperation from the call site', () => {
      const { logger, lines } = capture();

      // A provider that knows nothing about redaction still gets it.
      logger.info({ arbitrary: { nested: { password: 'still-redacted' } } });

      expect(lines[0]).not.toContain('still-redacted');
      expect(lines[0]).toContain('[redacted]');
    });
  });

  it('honours the configured level threshold', () => {
    const { logger, lines } = capture({ level: 'warn' });

    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown');
    logger.error('shown');

    expect(lines).toHaveLength(2);
  });

  it('only configures the pretty transport outside production', () => {
    expect(optionsFor({ pretty: false }).transport).toBeUndefined();
    expect(optionsFor({ pretty: true }).transport).toMatchObject({
      target: 'pino-pretty',
    });
  });

  it('excludes health probes from automatic request logging', () => {
    const { autoLogging } = optionsFor();

    /**
     * `originalUrl` is what matters: Nest mounts this middleware, so Express
     * rewrites `url` relative to the mount point and a liveness request
     * arrives with `url: '/'`. The wiring itself is covered end-to-end in
     * test/logging.e2e-spec.ts — a predicate test alone cannot catch that.
     */
    const req = (originalUrl: string) =>
      ({ originalUrl, url: '/' }) as unknown as IncomingMessage;

    expect(autoLogging.ignore(req('/health/live'))).toBe(true);
    expect(autoLogging.ignore(req('/health/ready'))).toBe(true);
    expect(autoLogging.ignore(req('/health/ready?verbose=1'))).toBe(true);
    expect(autoLogging.ignore(req('/metrics'))).toBe(true);
    expect(autoLogging.ignore(req('/api/v1/orders'))).toBe(false);
  });

  it('reuses the ambient request id, falling back to the inbound header', () => {
    const { genReqId } = optionsFor();
    const req = {
      headers: { 'x-request-id': 'from-header' },
    } as unknown as IncomingMessage;

    RequestContext.run({ requestId: 'from-context' }, () => {
      expect(genReqId(req)).toBe('from-context');
    });

    expect(genReqId(req)).toBe('from-header');
  });
});
