import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckError,
  type HealthCheckResult,
  HealthCheckService,
  type HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { NoEnvelope } from '@common/decorators/no-envelope.decorator';
import { redisConfig } from '@config/redis.config';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { Public } from '@modules/auth/auth.decorators';

import { RedisHealthIndicator } from './redis.health';
import { ShutdownState } from './shutdown-state.service';

/**
 * Version-neutral and excluded from the global prefix, so probe paths stay at
 * `/health/*` across API versions. `@NoEnvelope()` keeps the Terminus payload
 * intact for orchestrators.
 *
 * `@Public()` is not optional here. Routes are authenticated by default, and an
 * orchestrator presents no credentials — without this, readiness would fail
 * closed and the orchestrator would kill a perfectly healthy instance.
 *
 * `@SkipThrottle()` keeps probes off the Nest rate limiter so an orchestrator
 * cannot trip burst/minute ceilings while checking health.
 */
@Public()
@SkipThrottle({ burst: true, minute: true })
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly shutdownState: ShutdownState,
    @Inject(redisConfig.KEY)
    private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  /**
   * Liveness deliberately checks nothing external. A liveness probe that
   * depends on the database turns a database blip into a restart loop.
   */
  @Get('live')
  @NoEnvelope()
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /** Readiness gates traffic on dependencies actually being reachable. */
  @Get('ready')
  @NoEnvelope()
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.shutdownCheck(),
      () =>
        this.prismaHealth.pingCheck('database', this.prisma, {
          timeout: this.config.healthTimeoutMs,
        }),
      () => this.redisHealth.isHealthy('redis'),
    ]);
  }

  /**
   * Fails readiness the instant shutdown begins, ahead of queue/connection
   * draining, so an orchestrator stops routing new traffic while in-flight
   * work still has time to finish within the drain window.
   */
  private shutdownCheck(): HealthIndicatorResult {
    if (this.shutdownState.isShuttingDown) {
      throw new HealthCheckError('Application is shutting down', {
        shutdown: { status: 'down' },
      });
    }
    return { shutdown: { status: 'up' } };
  }
}
