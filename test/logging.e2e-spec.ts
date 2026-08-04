import { Writable } from 'node:stream';

import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import request from 'supertest';

import { buildLoggerParams } from '@infrastructure/logger/logger.options';

@Controller()
class ProbeController {
  @Get('health/live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('widgets')
  widgets(): string[] {
    return ['a'];
  }
}

/**
 * Exercises the logger through the real middleware rather than calling the
 * predicate directly.
 *
 * A unit test of `autoLogging.ignore` passes happily while the wiring is
 * broken: Nest mounts the middleware, Express rewrites `req.url` relative to
 * the mount point, and the predicate never sees the path the client requested.
 * Only a request through the stack catches that.
 */
describe('Request logging (integration)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let lines: string[];

  beforeAll(async () => {
    lines = [];

    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });

    const params = buildLoggerParams({ level: 'info', pretty: false });

    const moduleRef = await Test.createTestingModule({
      imports: [
        PinoLoggerModule.forRoot({
          ...params,
          pinoHttp: [params.pinoHttp, stream] as never,
        }),
      ],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('logs a completion entry for an ordinary request', async () => {
    await request(server).get('/widgets').expect(200);

    const entries = lines.map(
      (line) => JSON.parse(line) as Record<string, any>,
    );
    const completion = entries.find((entry) => entry.res !== undefined);

    expect(completion).toBeDefined();
    expect(completion?.req.url).toBe('/widgets');
    expect(completion?.res.statusCode).toBe(200);
  });

  it('carries a request id on the completion entry', async () => {
    const res = await request(server)
      .get('/widgets')
      .set('x-request-id', 'log-correlation-1');

    const entries = lines.map(
      (line) => JSON.parse(line) as Record<string, any>,
    );
    const completion = entries.find((entry) => entry.res !== undefined);

    expect(res.status).toBe(200);
    expect(completion?.requestId).toBe('log-correlation-1');
  });

  it('emits no completion entry for a liveness probe', async () => {
    await request(server).get('/health/live').expect(200);

    expect(lines).toHaveLength(0);
  });

  it('emits no completion entry for a readiness probe with a query string', async () => {
    await request(server).get('/health/live?verbose=1').expect(200);

    expect(lines).toHaveLength(0);
  });

  it('emits one line of valid JSON per entry', async () => {
    await request(server).get('/widgets').expect(200);

    for (const line of lines) {
      expect(line.trimEnd()).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
