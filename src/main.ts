import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { appConfig } from '@config/app.config';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  // Buffered so framework boot logs are replayed through pino rather than
  // written in Nest's default format.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  configureApp(app);

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  await app.listen(config.port, config.host);
}

void bootstrap();
