import { type INestApplication, VersioningType } from '@nestjs/common';

import { HEALTH_PATHS } from '@common/http/health-routes';

export const API_PREFIX = 'api';
export const DEFAULT_API_VERSION = '1';

/**
 * Application-level configuration that cannot be expressed as a provider.
 *
 * Shared by `main.ts` and the e2e helper so tests exercise the same routing
 * surface the server actually serves, rather than an approximation of it.
 */
export function configureApp(app: INestApplication): void {
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
