import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CommonModule } from '@common/common.module';
import { RequestContextMiddleware } from '@common/middleware/request-context.middleware';
import {
  appConfig,
  databaseConfig,
  envFilePaths,
  loggerConfig,
  redisConfig,
  validateEnv,
} from '@config/index';
import { HealthModule } from '@infrastructure/health/health.module';
import { LoggerModule } from '@infrastructure/logger/logger.module';
import { PrismaModule } from '@infrastructure/prisma/prisma.module';
import { RedisModule } from '@infrastructure/redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: envFilePaths(),
      validate: validateEnv,
      load: [appConfig, databaseConfig, redisConfig, loggerConfig],
    }),
    LoggerModule,
    PrismaModule,
    RedisModule,
    HealthModule,
    CommonModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
