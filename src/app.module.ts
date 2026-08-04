import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { json, urlencoded } from 'express';

import { CommonModule } from '@common/common.module';
import { RequestContextMiddleware } from '@common/middleware/request-context.middleware';
import {
  appConfig,
  AUTH_BASE_PATH,
  authConfig,
  databaseConfig,
  envFilePaths,
  loggerConfig,
  mailConfig,
  redisConfig,
  securityConfig,
  throttleConfig,
  usageLimitsConfig,
  validateEnv,
} from '@config/index';
import { HealthModule } from '@infrastructure/health/health.module';
import { LoggerModule } from '@infrastructure/logger/logger.module';
import { MailModule } from '@infrastructure/mail/mail.module';
import { PrismaModule } from '@infrastructure/prisma/prisma.module';
import { RedisModule } from '@infrastructure/redis/redis.module';
import { AuthModule } from '@modules/auth/auth.module';
import { BetterAuthMiddleware } from '@modules/auth/better-auth.middleware';
import { AuthorizationModule } from '@modules/authorization/authorization.module';
import { ThrottlingModule } from '@modules/throttling/throttling.module';
import { UsageLimitsModule } from '@modules/usage-limits/usage-limits.module';

import { API_PREFIX } from './bootstrap';

/**
 * Every path Better Auth owns, as `MiddlewareConsumer` expects it.
 *
 * Note the missing `api/`: middleware paths are resolved **relative to the
 * global prefix**, so a pattern of `api/auth/…` would match `/api/api/auth/…`
 * and every auth request would fall through to Nest's router and 404 — which
 * looks like a broken auth library rather than a mispatched mount.
 *
 * Derived from `AUTH_BASE_PATH` and `API_PREFIX` rather than written out, so the
 * mount, the body-parser exclusion, and the configured base path cannot drift.
 */
const AUTH_ROUTE_PATTERN = `${AUTH_BASE_PATH.replace(
  `/${API_PREFIX}/`,
  '',
)}/{*splat}`;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: envFilePaths(),
      validate: validateEnv,
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        loggerConfig,
        authConfig,
        securityConfig,
        mailConfig,
        throttleConfig,
        usageLimitsConfig,
      ],
    }),
    LoggerModule,
    PrismaModule,
    RedisModule,
    MailModule,
    AuthModule,
    AuthorizationModule,
    ThrottlingModule,
    UsageLimitsModule,
    HealthModule,
    CommonModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * Middleware order is the contract here, and every step depends on the one
   * before it:
   *
   *   1. `RequestContextMiddleware` opens the correlation scope, so everything
   *      after it — including the auth router — logs under one request id.
   *   2. `BetterAuthMiddleware` serves `/api/auth/*` and ends the response. It
   *      must see an *unparsed* body, which is why it precedes the parsers.
   *   3. The body parsers cover every other path. They are registered here
   *      rather than by Nest itself (`bodyParser: false` in `APP_OPTIONS`)
   *      because Nest registers its own before module middleware, which would
   *      consume the auth body before step 2 could read it.
   *
   * `nestjs-pino`'s request logger is applied by `LoggerModule`, which is
   * imported ahead of this module's own `configure`, so it stays between the
   * context scope and the auth router.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');

    consumer.apply(BetterAuthMiddleware).forRoutes(`${AUTH_ROUTE_PATTERN}`);

    consumer
      .apply(json({ limit: '1mb' }), urlencoded({ extended: true }))
      .exclude(AUTH_ROUTE_PATTERN)
      .forRoutes('{*splat}');
  }
}
