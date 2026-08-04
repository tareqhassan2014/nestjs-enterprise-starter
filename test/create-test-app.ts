import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { configureApp } from '@/bootstrap';

/**
 * Builds the app the way `main.ts` does, so e2e tests exercise the real
 * routing surface and the real global providers.
 */
export async function createTestApp(
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  extraImports: unknown[] = [],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule, ...(extraImports as [])],
  });

  if (customise) {
    builder = customise(builder);
  }

  const moduleRef = await builder.compile();

  // Log assertions live in unit tests; e2e output stays readable.
  const app = moduleRef.createNestApplication({ logger: false });

  configureApp(app);

  await app.init();

  return app;
}
