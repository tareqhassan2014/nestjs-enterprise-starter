import { registerAs } from '@nestjs/config';

import { getEnv } from './env.validation';

/**
 * Admin dashboards, Prometheus scrape, and OpenAPI exposure.
 */
export const observabilityConfig = registerAs('observability', () => {
  const env = getEnv();

  return {
    metricsEnabled: env.METRICS_ENABLED,
    metricsBearerToken: env.METRICS_BEARER_TOKEN,
    swaggerEnabled: env.SWAGGER_ENABLED ?? env.NODE_ENV === 'development',
    adminUsageTopN: env.ADMIN_USAGE_TOP_N,
  };
});

export type ObservabilityConfig = ReturnType<typeof observabilityConfig>;
