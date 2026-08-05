import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { appConfig } from '@config/app.config';
import { observabilityConfig } from '@config/observability.config';

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
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('NestJS Enterprise Starter')
        .setDescription(
          [
            'Versioned Nest API under `/api/v1` uses the success/error envelope.',
            'Outside that contract: `/api/auth/*` (Better Auth), `/health/*`,',
            '`/metrics` (Prometheus text), and `POST /api/v1/billing/webhook`',
            '(Stripe-minimal acknowledgements).',
            'Admin routes are tagged `Admin` and require staff permissions.',
          ].join(' '),
        )
        .setVersion('1')
        .addTag('Admin', 'Operator monitoring and billing inspection')
        .addTag('Account', 'Caller account and session surfaces')
        .addTag('Public', 'Unauthenticated Nest routes')
        .addCookieAuth('session_token')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, {
      // Keep docs outside the versioned `/api` prefix.
      useGlobalPrefix: false,
    });
  }

  await app.listen(config.port, config.host);
}

void bootstrap();
