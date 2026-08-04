import type { INestApplication } from '@nestjs/common';
import type { Redis as RedisClient } from 'ioredis';
import request from 'supertest';

import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import { createTestApp } from './create-test-app';

describe('Health checks (integration)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  describe('liveness', () => {
    it('is served outside the API prefix and version', async () => {
      await request(server).get('/health/live').expect(200);
      await request(server).get('/api/v1/health/live').expect(404);
      await request(server).get('/v1/health/live').expect(404);
    });

    it('returns the health payload without the envelope', async () => {
      const res = await request(server).get('/health/live');

      expect(res.body).toMatchObject({ status: 'ok' });
      expect(res.body).not.toHaveProperty('success');
      expect(res.body).not.toHaveProperty('meta');
    });
  });

  describe('readiness', () => {
    it('reports both dependencies up when reachable', async () => {
      const res = await request(server).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.info).toHaveProperty('database');
      expect(res.body.info).toHaveProperty('redis');
      expect(res.body.info.database.status).toBe('up');
      expect(res.body.info.redis.status).toBe('up');
    });

    it('is served outside the API prefix', async () => {
      await request(server).get('/api/v1/health/ready').expect(404);
    });
  });
});

describe('Readiness with a failing dependency (integration)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let downClient: RedisClient;

  beforeAll(async () => {
    // A client pointed at a closed port stands in for Redis being down.
    const { Redis } = await import('ioredis');

    downClient = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 300,
      retryStrategy: () => null,
    });
    // Expected: without a listener this becomes an unhandled error event.
    downClient.on('error', () => undefined);

    app = await createTestApp((builder) =>
      builder.overrideProvider(REDIS_CLIENT).useValue(downClient),
    );
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
    downClient.disconnect();
  });

  it('stays alive even though a dependency is down', async () => {
    await request(server).get('/health/live').expect(200);
  });

  it('returns 503 and names the failing dependency', async () => {
    const res = await request(server).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toHaveProperty('redis');
    expect(res.body.error.redis.status).toBe('down');
  });

  it('returns the health payload, not the generic error envelope', async () => {
    const res = await request(server).get('/health/ready');

    expect(res.body).not.toHaveProperty('success');
    expect(res.body).toHaveProperty('details');
  });
});
