import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { json, raw, urlencoded } from 'express';

import { CommonModule } from '@common/common.module';
import { IdempotencyModule } from '@common/idempotency/idempotency.module';
import { RequestContextMiddleware } from '@common/middleware/request-context.middleware';
import {
  appConfig,
  AUTH_BASE_PATH,
  authConfig,
  creditsConfig,
  databaseConfig,
  envFilePaths,
  featureFlagsConfig,
  idempotencyConfig,
  loggerConfig,
  mailConfig,
  mcpConfig,
  observabilityConfig,
  queuesConfig,
  redisConfig,
  securityConfig,
  shutdownConfig,
  storageConfig,
  stripeConfig,
  throttleConfig,
  usageLimitsConfig,
  validateEnv,
} from '@config/index';
import { HealthModule } from '@infrastructure/health/health.module';
import { LoggerModule } from '@infrastructure/logger/logger.module';
import { MailModule } from '@infrastructure/mail/mail.module';
import { PrismaModule } from '@infrastructure/prisma/prisma.module';
import { RedisModule } from '@infrastructure/redis/redis.module';
import { StorageModule } from '@infrastructure/storage/storage.module';
import { AdminModule } from '@modules/admin/admin.module';
import { ApiKeysModule } from '@modules/api-keys/api-keys.module';
import { AuthModule } from '@modules/auth/auth.module';
import { BetterAuthMiddleware } from '@modules/auth/better-auth.middleware';
import { AuthorizationModule } from '@modules/authorization/authorization.module';
import { BillingModule } from '@modules/billing/billing.module';
import { CreditsModule } from '@modules/credits/credits.module';
import { FeatureFlagsModule } from '@modules/feature-flags/feature-flags.module';
import { McpModule } from '@modules/mcp/mcp.module';
import { MetricsModule } from '@modules/metrics/metrics.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';
import { PlansModule } from '@modules/plans/plans.module';
import { QueuesModule } from '@modules/queues/queues.module';
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

/** Stripe webhook under URI versioning — raw body required for signatures. */
const STRIPE_WEBHOOK_ROUTE = {
  path: 'v1/billing/webhook',
  method: RequestMethod.POST,
} as const;

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
        creditsConfig,
        stripeConfig,
        observabilityConfig,
        mcpConfig,
        queuesConfig,
        storageConfig,
        featureFlagsConfig,
        idempotencyConfig,
        shutdownConfig,
      ],
    }),
    EventEmitterModule.forRoot(),
    LoggerModule,
    PrismaModule,
    RedisModule,
    MailModule,
    StorageModule,
    FeatureFlagsModule,
    QueuesModule,
    AuthModule,
    AuthorizationModule,
    // OrganizationContextGuard (APP_GUARD) must sit after Auth/Permissions and
    // before Plans/Throttling/UsageLimits/Credits — see OrganizationsModule.
    OrganizationsModule,
    PlansModule,
    ThrottlingModule,
    UsageLimitsModule,
    CreditsModule,
    BillingModule,
    ApiKeysModule,
    McpModule,
    MetricsModule,
    AdminModule,
    HealthModule,
    // Must precede CommonModule so IdempotencyInterceptor wraps
    // ResponseEnvelopeInterceptor — see IdempotencyModule.
    IdempotencyModule,
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
   *   3. Stripe webhook gets `express.raw` so signature verification sees bytes.
   *   4. JSON / urlencoded cover every other path (auth + webhook excluded).
   *
   * `nestjs-pino`'s request logger is applied by `LoggerModule`, which is
   * imported ahead of this module's own `configure`, so it stays between the
   * context scope and the auth router.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');

    consumer.apply(BetterAuthMiddleware).forRoutes(`${AUTH_ROUTE_PATTERN}`);

    consumer
      .apply(raw({ type: 'application/json' }))
      .forRoutes(STRIPE_WEBHOOK_ROUTE);

    consumer
      .apply(json({ limit: '1mb' }), urlencoded({ extended: true }))
      .exclude(AUTH_ROUTE_PATTERN, STRIPE_WEBHOOK_ROUTE.path)
      .forRoutes('{*splat}');
  }
}
