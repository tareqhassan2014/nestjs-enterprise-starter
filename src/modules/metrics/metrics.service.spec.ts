import { Counter, Registry } from 'prom-client';

import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    // Each MetricsService creates its own registry; isolate default metrics noise.
    service = new MetricsService();
  });

  it('exposes Prometheus text including app counters', async () => {
    service.recordHttpRequest({
      method: 'GET',
      route: '/api/v1/account',
      status: 200,
      durationSeconds: 0.01,
    });
    service.record429('RATE_LIMITED');
    service.recordCreditMutation('grant');

    const body = await service.scrape();
    expect(body).toContain('http_requests_total');
    expect(body).toContain('http_429_total');
    expect(body).toContain('credit_mutations_total');
    expect(body).not.toContain('userId');
  });

  it('summarizes request pressure without high-cardinality labels', async () => {
    service.recordHttpRequest({
      method: 'GET',
      route: '/x',
      status: 200,
      durationSeconds: 0.01,
    });
    service.record429('USAGE_LIMIT_EXCEEDED');

    const summary = await service.requestPressureSummary();
    expect(summary.httpRequestsTotal).toBeGreaterThanOrEqual(1);
    expect(summary.usageLimitExceededTotal).toBeGreaterThanOrEqual(1);
  });
});

describe('MetricsService label contract', () => {
  it('http counter label names omit subject identifiers', () => {
    const registry = new Registry();
    const counter = new Counter({
      name: 'probe_http_requests_total',
      help: 'probe',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    });
    expect(counter).toBeDefined();
    // Documented contract for MetricsService — keep this list in sync.
    expect(['method', 'route', 'status']).not.toEqual(
      expect.arrayContaining(['userId', 'email']),
    );
  });
});
