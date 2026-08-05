import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';

import { observabilityConfig } from '@config/observability.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import {
  type LimitExceededPayload,
  OBS_LIMIT_EXCEEDED_EVENT,
} from '@modules/metrics/observability.events';
import { MetricsService } from '@modules/metrics/metrics.service';

const ZSET_TTL_SECONDS = 48 * 60 * 60;
const MAX_TOP_N = 100;

/**
 * Bounded Redis ZSET side channel for top-429 dashboards.
 * Keys: `obs:429:{code}:{yyyyMMddHH}` — no KEYS/SCAN of throttle keyspace.
 */
@Injectable()
export class RateLimitObservationsService {
  private readonly logger = new Logger(RateLimitObservationsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(observabilityConfig.KEY)
    private readonly observability: ConfigType<typeof observabilityConfig>,
    private readonly metrics: MetricsService,
  ) {}

  @OnEvent(OBS_LIMIT_EXCEEDED_EVENT)
  async onLimitExceeded(payload: LimitExceededPayload): Promise<void> {
    this.metrics.record429(payload.code);

    const hour = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
    const subjectKey = `obs:429:${payload.code}:subject:${hour}`;
    const routeKey = `obs:429:${payload.code}:route:${hour}`;

    try {
      const pipeline = this.redis.pipeline();
      pipeline.zincrby(subjectKey, 1, payload.subject);
      pipeline.expire(subjectKey, ZSET_TTL_SECONDS);
      pipeline.zincrby(routeKey, 1, payload.route || 'unknown');
      pipeline.expire(routeKey, ZSET_TTL_SECONDS);
      await pipeline.exec();
    } catch (error) {
      this.logger.warn(
        `Failed to record 429 observation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async topSubjects(
    code: LimitExceededPayload['code'],
    limit?: number,
  ): Promise<Array<{ subject: string; count: number }>> {
    const topN = this.clampTopN(limit);
    const key = this.currentHourKey(code, 'subject');
    const rows = await this.redis.zrevrange(key, 0, topN - 1, 'WITHSCORES');
    return parseZset(rows);
  }

  async topRoutes(
    code: LimitExceededPayload['code'],
    limit?: number,
  ): Promise<Array<{ route: string; count: number }>> {
    const topN = this.clampTopN(limit);
    const key = this.currentHourKey(code, 'route');
    const rows = await this.redis.zrevrange(key, 0, topN - 1, 'WITHSCORES');
    return parseZset(rows).map((row) => ({
      route: row.subject,
      count: row.count,
    }));
  }

  private currentHourKey(
    code: LimitExceededPayload['code'],
    dimension: 'subject' | 'route',
  ): string {
    const hour = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
    return `obs:429:${code}:${dimension}:${hour}`;
  }

  private clampTopN(limit?: number): number {
    const configured = this.observability.adminUsageTopN;
    const requested = limit ?? configured;
    return Math.min(Math.max(1, requested), MAX_TOP_N);
  }
}

function parseZset(rows: string[]): Array<{ subject: string; count: number }> {
  const out: Array<{ subject: string; count: number }> = [];
  for (let i = 0; i < rows.length; i += 2) {
    out.push({
      subject: rows[i]!,
      count: Number(rows[i + 1] ?? 0),
    });
  }
  return out;
}
