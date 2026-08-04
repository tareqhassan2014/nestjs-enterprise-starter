import { type NestApplicationOptions, VersioningType } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { HEALTH_PATHS } from '@common/http/health-routes';
import { securityConfig } from '@config/security.config';

export const API_PREFIX = 'api';
export const DEFAULT_API_VERSION = '1';

/**
 * Options `NestFactory.create` is called with.
 *
 * Shared with the e2e helper deliberately. `createNestApplication` does not
 * inherit anything from `main.ts`, so a helper that built the app with different
 * options would exercise a body-parsing arrangement the server never uses —
 * precisely the divergence the helper exists to prevent.
 */
export const APP_OPTIONS: NestApplicationOptions = {
  /**
   * Off, because Better Auth's handler reads the raw request stream and a body
   * Nest had already consumed leaves those requests hanging. JSON and urlencoded
   * parsing is re-added as middleware in `AppModule.configure`, ordered after
   * the auth mount and excluded from its paths.
   */
  bodyParser: false,
};

/**
 * Application-level configuration that cannot be expressed as a provider.
 *
 * Shared by `main.ts` and the e2e helper so tests exercise the same routing
 * surface the server actually serves, rather than an approximation of it.
 *
 * Typed against the Express application rather than `INestApplication` because
 * `trust proxy` is an Express setting and the auth mount depends on it being
 * right — see `client-ip.ts`.
 */
export function configureApp(app: NestExpressApplication): void {
  const security = app.get<ConfigType<typeof securityConfig>>(
    securityConfig.KEY,
  );

  /**
   * Governs how Express resolves `req.ip`, which is the only address the auth
   * layer trusts (see `client-ip.ts`). Off by default: believing
   * `X-Forwarded-For` unconditionally lets any client choose its own rate-limit
   * identity.
   */
  app.set('trust proxy', security.trustProxy);

  /**
   * Registered here rather than as module middleware so it also covers
   * `/api/auth/*` and error responses. Neither touches the request body, so
   * running ahead of the correlation scope costs nothing.
   */
  app.use(
    helmet({
      /**
       * This service returns JSON and renders nothing, so it needs no content
       * sources at all. Far tighter than Helmet's browser-page defaults.
       */
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      /**
       * Only when actually served over HTTPS. Emitting it on plain-HTTP local
       * development would pin `localhost` to HTTPS in the developer's browser
       * and break every other project on that host.
       */
      hsts: security.servesHttps
        ? { maxAge: 15552000, includeSubDomains: true }
        : false,
    }),
  );

  app.disable('x-powered-by');

  /**
   * An explicit allowlist with credentials enabled. The schema has already
   * rejected a wildcard, which browsers refuse to combine with credentials.
   * The same list feeds Better Auth's `trustedOrigins`, so the CORS decision and
   * the CSRF origin check cannot disagree.
   */
  app.enableCors({
    origin: security.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  app.setGlobalPrefix(API_PREFIX, {
    // Probe paths stay stable across API versions.
    exclude: HEALTH_PATHS.map((path) => path.replace(/^\//, '')),
  });

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: DEFAULT_API_VERSION,
  });

  app.enableShutdownHooks();
}
