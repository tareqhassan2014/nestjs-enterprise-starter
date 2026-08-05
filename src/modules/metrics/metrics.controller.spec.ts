import { NotFoundException, UnauthorizedException } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  const metrics = {
    scrape: jest.fn(() => Promise.resolve('# HELP probe\n')),
  };

  it('404 when metrics disabled', async () => {
    const controller = new MetricsController(
      metrics as unknown as MetricsService,
      {
        metricsEnabled: false,
        metricsBearerToken: undefined,
        swaggerEnabled: false,
        adminUsageTopN: 20,
      },
    );

    await expect(controller.scrape(undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('401 when bearer required and missing', async () => {
    const controller = new MetricsController(
      metrics as unknown as MetricsService,
      {
        metricsEnabled: true,
        metricsBearerToken: 'secret',
        swaggerEnabled: false,
        adminUsageTopN: 20,
      },
    );

    await expect(controller.scrape(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('returns scrape body when enabled and authorized', async () => {
    const controller = new MetricsController(
      metrics as unknown as MetricsService,
      {
        metricsEnabled: true,
        metricsBearerToken: 'secret',
        swaggerEnabled: false,
        adminUsageTopN: 20,
      },
    );

    await expect(controller.scrape('Bearer secret')).resolves.toContain('HELP');
  });
});
