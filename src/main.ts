import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { appConfig } from '@config/app.config';
import { observabilityConfig } from '@config/observability.config';
import { createOpenApiDocument } from '@infrastructure/openapi/openapi.document';

import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  // Buffered so framework boot logs are replayed through pino rather than
  // written in Nest's default format. APP_OPTIONS is shared with the e2e helper
  // so both build the same app — notably `bodyParser: false`.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...APP_OPTIONS,
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  configureApp(app);

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  const observability = app.get<ConfigType<typeof observabilityConfig>>(
    observabilityConfig.KEY,
  );

  if (observability.swaggerEnabled) {
    const document = createOpenApiDocument(app);
    SwaggerModule.setup('docs', app, document, {
      // Keep docs outside the versioned `/api` prefix.
      useGlobalPrefix: false,
    });
  }

  await app.listen(config.port, config.host);
}

void bootstrap();
