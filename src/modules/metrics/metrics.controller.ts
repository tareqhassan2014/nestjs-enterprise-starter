import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  NotFoundException,
  UnauthorizedException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { NoEnvelope } from '@common/decorators/no-envelope.decorator';
import { observabilityConfig } from '@config/observability.config';
import { Public } from '@modules/auth/auth.decorators';

import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint. Outside `/api`, outside the success envelope,
 * and not session-authenticated — optional bearer token only.
 */
@ApiExcludeController()
@Public()
@SkipThrottle({ burst: true, minute: true })
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(observabilityConfig.KEY)
    private readonly observability: ConfigType<typeof observabilityConfig>,
  ) {}

  @Get()
  @NoEnvelope()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<string> {
    if (!this.observability.metricsEnabled) {
      throw new NotFoundException();
    }

    const expected = this.observability.metricsBearerToken;
    if (expected) {
      const provided = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : undefined;
      if (provided !== expected) {
        throw new UnauthorizedException();
      }
    }

    return this.metrics.scrape();
  }
}
