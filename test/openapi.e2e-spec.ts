import type { NestExpressApplication } from '@nestjs/platform-express';

import {
  createOpenApiDocument,
  OPENAPI_API_KEY,
  OPENAPI_SESSION_BEARER,
  OPENAPI_SESSION_COOKIE,
} from '@infrastructure/openapi/openapi.document';

import { createTestApp } from './create-test-app';

/**
 * OpenAPI contract checks — security schemes and Admin tagging.
 * Needs a real app boot (same as other integration suites).
 */
describe('OpenAPI contract (integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('lists session cookie, session bearer, and API-key schemes', () => {
    const document = createOpenApiDocument(app);
    const schemes = document.components?.securitySchemes ?? {};

    expect(schemes).toHaveProperty(OPENAPI_SESSION_COOKIE);
    expect(schemes).toHaveProperty(OPENAPI_SESSION_BEARER);
    expect(schemes).toHaveProperty(OPENAPI_API_KEY);
  });

  it('keeps Admin tag on admin routes and leaves the webhook unsecured', () => {
    const document = createOpenApiDocument(app);
    const adminPath = Object.entries(document.paths ?? {}).find(([path]) =>
      path.includes('/admin/'),
    );
    expect(adminPath).toBeDefined();

    const [, adminItem] = adminPath!;
    const adminOperation =
      adminItem?.get ?? adminItem?.post ?? adminItem?.put ?? adminItem?.delete;
    expect(adminOperation?.tags).toContain('Admin');
    expect(adminOperation?.security).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ [OPENAPI_SESSION_COOKIE]: [] }),
        expect.objectContaining({ [OPENAPI_SESSION_BEARER]: [] }),
      ]),
    );

    const webhookPath = Object.keys(document.paths ?? {}).find((path) =>
      path.endsWith('/billing/webhook'),
    );
    expect(webhookPath).toBeDefined();
    const webhook = document.paths?.[webhookPath!]?.post;
    expect(webhook).toBeDefined();
    expect(webhook?.security ?? []).toEqual([]);
    expect(webhook?.tags).toContain('Public');
  });

  it('does not list Better Auth library paths as Nest operations', () => {
    const document = createOpenApiDocument(app);
    const authPaths = Object.keys(document.paths ?? {}).filter((path) =>
      path.includes('/api/auth'),
    );
    expect(authPaths).toEqual([]);
  });
});
