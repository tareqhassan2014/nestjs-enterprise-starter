import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';

/** Cookie name / OpenAPI scheme id for Better Auth session cookies. */
export const OPENAPI_SESSION_COOKIE = 'session_token';

/** Bearer scheme for Better Auth session tokens (`Authorization: Bearer`). */
export const OPENAPI_SESSION_BEARER = 'session_bearer';

/** Bearer scheme for agent API keys (`Authorization: Bearer <key>`). */
export const OPENAPI_API_KEY = 'api_key';

/**
 * Shared OpenAPI document definition — used by `main.ts` and tests so the
 * security schemes and tags cannot drift between boot and assertions.
 */
export function buildOpenApiDocumentConfig() {
  return new DocumentBuilder()
    .setTitle('NestJS Enterprise Starter')
    .setDescription(
      [
        'Versioned Nest API under `/api/v1` uses the success/error envelope.',
        'Outside that contract: `/api/auth/*` (Better Auth), `/health/*`,',
        '`/metrics` (Prometheus text), `POST /api/v1/billing/webhook`',
        '(Stripe-minimal acknowledgements), and `/mcp` (Streamable HTTP MCP',
        'authenticated with the `api_key` bearer scheme — excluded from path',
        'items because it is not an enveloped Nest JSON API).',
        'Admin routes are tagged `Admin` and require staff permissions.',
        'Nest session routes accept `session_token` (cookie) and/or',
        '`session_bearer` (Authorization Bearer session token).',
      ].join(' '),
    )
    .setVersion('1')
    .addTag('Admin', 'Operator monitoring and billing inspection')
    .addTag('Account', 'Caller account and session surfaces')
    .addTag('Organizations', 'Organization membership and billing context')
    .addTag('Public', 'Unauthenticated Nest routes')
    .addCookieAuth(
      OPENAPI_SESSION_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        name: OPENAPI_SESSION_COOKIE,
        description: 'Better Auth session cookie',
      },
      OPENAPI_SESSION_COOKIE,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'session',
        description: 'Better Auth session token in Authorization: Bearer',
      },
      OPENAPI_SESSION_BEARER,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'api_key',
        description:
          'Agent API key in Authorization: Bearer (MCP /mcp; create keys via POST /api/v1/account/api-keys)',
      },
      OPENAPI_API_KEY,
    )
    .build();
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(app, buildOpenApiDocumentConfig());
}
