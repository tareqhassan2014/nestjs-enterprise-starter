import { Injectable, Logger } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * In-process Prometheus registry. Labels stay low-cardinality: method, route
 * template, status — never userId or email.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();

  private readonly httpRequests: Counter<string>;
  private readonly httpDuration: Histogram<string>;
  private readonly http429: Counter<string>;
  private readonly creditMutations: Counter<string>;
  private readonly mcpToolInvocations: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests handled by Nest',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.http429 = new Counter({
      name: 'http_429_total',
      help: 'HTTP 429 responses by application error code',
      labelNames: ['code'],
      registers: [this.registry],
    });

    this.creditMutations = new Counter({
      name: 'credit_mutations_total',
      help: 'Credit ledger mutations by type',
      labelNames: ['type'],
      registers: [this.registry],
    });

    this.mcpToolInvocations = new Counter({
      name: 'mcp_tool_invocations_total',
      help: 'MCP tool invocations by tool name and outcome class',
      labelNames: ['tool', 'outcome'],
      registers: [this.registry],
    });
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  recordHttpRequest(params: {
    method: string;
    route: string;
    status: number;
    durationSeconds: number;
  }): void {
    const labels = {
      method: params.method,
      route: params.route,
      status: String(params.status),
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, params.durationSeconds);
  }

  record429(code: 'RATE_LIMITED' | 'USAGE_LIMIT_EXCEEDED'): void {
    this.http429.inc({ code });
  }

  recordCreditMutation(
    type: 'grant' | 'spend' | 'refund' | 'adjust',
  ): void {
    this.creditMutations.inc({ type });
  }

  recordMcpToolInvocation(
    tool: string,
    outcome: 'success' | 'denied' | 'error',
  ): void {
    this.mcpToolInvocations.inc({ tool, outcome });
  }

  /**
   * Approximate request pressure from counter totals.
   * Not a sliding window — suitable for ops dashboards, not billing.
   */
  async requestPressureSummary(): Promise<{
    httpRequestsTotal: number;
    rateLimitedTotal: number;
    usageLimitExceededTotal: number;
  }> {
    try {
      const http = await this.httpRequests.get();
      const limited = await this.http429.get();

      const sumValues = (
        metric: Awaited<ReturnType<Counter<string>['get']>>,
        filter?: (labels: Record<string, string>) => boolean,
      ) =>
        metric.values
          .filter((row) =>
            filter ? filter(row.labels as Record<string, string>) : true,
          )
          .reduce((acc, row) => acc + row.value, 0);

      return {
        httpRequestsTotal: sumValues(http),
        rateLimitedTotal: sumValues(
          limited,
          (labels) => labels.code === 'RATE_LIMITED',
        ),
        usageLimitExceededTotal: sumValues(
          limited,
          (labels) => labels.code === 'USAGE_LIMIT_EXCEEDED',
        ),
      };
    } catch (error) {
      this.logger.warn(
        `Failed to read request pressure: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        httpRequestsTotal: 0,
        rateLimitedTotal: 0,
        usageLimitExceededTotal: 0,
      };
    }
  }
}
