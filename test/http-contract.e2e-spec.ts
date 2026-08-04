import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from './create-test-app';
import { ContractFixtureModule } from './fixtures/contract-fixture.module';

describe('HTTP contract (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    app = await createTestApp(undefined, [ContractFixtureModule]);
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  describe('routing', () => {
    it('serves controllers under the versioned prefix', async () => {
      await request(server).get('/api/v1/fixture/object').expect(200);
    });

    it('does not serve them unprefixed or unversioned', async () => {
      await request(server).get('/fixture/object').expect(404);
      await request(server).get('/api/fixture/object').expect(404);
    });
  });

  describe('success envelope', () => {
    it('wraps an object return', async () => {
      const res = await request(server).get('/api/v1/fixture/object');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: { id: '1', name: 'Ada' },
      });
      expect(res.body.meta.requestId).toEqual(expect.any(String));
      expect(res.body.meta.timestamp).toEqual(expect.any(String));
    });

    it('keeps an array intact as data', async () => {
      const res = await request(server).get('/api/v1/fixture/array');

      expect(res.body.data).toEqual(['one', 'two']);
    });

    it('returns data: null when a handler returns nothing', async () => {
      const res = await request(server).get('/api/v1/fixture/void');

      expect(res.body).toMatchObject({ success: true, data: null });
    });
  });

  describe('validation', () => {
    it('accepts a valid body', async () => {
      const res = await request(server)
        .post('/api/v1/fixture/users')
        .send({ email: 'ada@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ email: 'ada@example.com' });
    });

    it('rejects an undeclared property and names it', async () => {
      const res = await request(server)
        .post('/api/v1/fixture/users')
        .send({ email: 'ada@example.com', role: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.error.details)).toContain('role');
    });

    it('reports one detail entry per failing field', async () => {
      const res = await request(server)
        .post('/api/v1/fixture/users')
        .send({ email: 'not-an-email', address: { postalCode: '' } });

      const fields = (res.body.error.details as { field: string }[]).map(
        (detail) => detail.field,
      );

      expect(res.status).toBe(400);
      expect(fields).toContain('email');
      expect(fields).toContain('address.postalCode');
    });

    it('coerces a numeric query parameter', async () => {
      const res = await request(server).get('/api/v1/fixture/paged?page=2');

      expect(res.body.data).toEqual({ page: 2, type: 'number' });
    });

    it('rejects a non-numeric value for a numeric parameter', async () => {
      const res = await request(server).get('/api/v1/fixture/paged?page=abc');

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toContain('page');
    });
  });

  describe('error envelope', () => {
    it('maps an HTTP exception to its code', async () => {
      const res = await request(server).get('/api/v1/fixture/missing');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    });

    it('never leaks an unexpected error message or stack', async () => {
      const res = await request(server).get('/api/v1/fixture/boom');
      const body = JSON.stringify(res.body);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(body).not.toContain('postgres://');
      expect(body).not.toContain('internal-host');
      expect(body).not.toContain('at ');
      expect(res.body.error).not.toHaveProperty('stack');
    });

    it('maps a unique-constraint violation to 409 CONFLICT', async () => {
      const res = await request(server).get('/api/v1/fixture/conflict');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(JSON.stringify(res.body)).not.toContain('Unique constraint');
    });

    it('maps a missing record to 404 NOT_FOUND', async () => {
      const res = await request(server).get('/api/v1/fixture/gone');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('does not leak raw text for an unmapped database error', async () => {
      const res = await request(server).get('/api/v1/fixture/db-unknown');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('Raw database detail');
    });

    it('shares one envelope shape across every error source', async () => {
      // Sequential: supertest binds an ephemeral port per call, and firing
      // these concurrently races the listener.
      const responses = [
        await request(server)
          .post('/api/v1/fixture/users')
          .send({ email: 'nope' }),
        await request(server).get('/api/v1/fixture/missing'),
        await request(server).get('/api/v1/fixture/boom'),
      ];

      for (const res of responses) {
        expect(res.body).toMatchObject({
          success: false,
          error: { code: expect.any(String), message: expect.any(String) },
          meta: { timestamp: expect.any(String) },
        });
      }
    });
  });

  describe('envelope opt-out', () => {
    it('returns a bare body for an exempt handler', async () => {
      const res = await request(server).get('/api/v1/fixture/raw');

      expect(res.body).toEqual({ plain: true });
      expect(res.body).not.toHaveProperty('success');
      expect(res.body).not.toHaveProperty('meta');
    });

    it('still envelopes errors thrown from an exempt handler', async () => {
      const res = await request(server).get('/api/v1/fixture/raw-boom');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    });
  });

  describe('correlation', () => {
    it('matches meta.requestId to the x-request-id header', async () => {
      const res = await request(server).get('/api/v1/fixture/object');

      expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
    });

    it('propagates a client-supplied id into the envelope', async () => {
      const res = await request(server)
        .get('/api/v1/fixture/object')
        .set('x-request-id', 'client-abc-123');

      expect(res.body.meta.requestId).toBe('client-abc-123');
      expect(res.headers['x-request-id']).toBe('client-abc-123');
    });

    it('regenerates a malformed id rather than rejecting the request', async () => {
      const res = await request(server)
        .get('/api/v1/fixture/object')
        .set('x-request-id', 'not valid!!');

      expect(res.status).toBe(200);
      expect(res.body.meta.requestId).not.toBe('not valid!!');
    });

    it('carries the correlation id onto error responses', async () => {
      const res = await request(server)
        .get('/api/v1/fixture/boom')
        .set('x-request-id', 'trace-me-42');

      expect(res.body.meta.requestId).toBe('trace-me-42');
    });
  });
});
