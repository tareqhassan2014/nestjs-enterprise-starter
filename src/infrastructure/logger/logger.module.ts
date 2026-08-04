import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { loggerConfig } from '@config/logger.config';

import { buildLoggerParams } from './logger.options';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [loggerConfig.KEY],
      useFactory: (config: ConfigType<typeof loggerConfig>) =>
        buildLoggerParams(config),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
