import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { APP_OPTIONS, configureApp } from '@/bootstrap';

/**
 * Builds the app the way `main.ts` does, so e2e tests exercise the real
 * routing surface and the real global providers.
 */
export async function createTestApp(
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  extraImports: unknown[] = [],
  options?: { logger?: false | ('error' | 'warn' | 'log' | 'debug' | 'verbose')[] },
): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule, ...(extraImports as [])],
  });

  if (customise) {
    builder = customise(builder);
  }

  const moduleRef = await builder.compile();

  // Log assertions live in unit tests; e2e output stays readable.
  //
  // APP_OPTIONS is spread in deliberately: `createNestApplication` inherits
  // nothing from `main.ts`, so omitting it would build the app with Nest's body
  // parsers enabled and the auth surface would hang here but work in production.
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    ...APP_OPTIONS,
    logger: options?.logger ?? false,
  });

  configureApp(app);

  await app.init();

  return app;
}
