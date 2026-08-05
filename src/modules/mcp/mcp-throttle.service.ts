import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { mcpConfig } from '@config/mcp.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

/**
 * Why a tool invocation was refused at the throttle stage.
 *
 * Two members, not one, and the distinction is the point: `request-throttling`
 * requires a storage failure be distinguishable from a genuine exceedance, and
 * collapsing them tells an agent to wait out a window that will never elapse
 * while hiding an outage behind a routine, self-clearing condition.
 */
export type McpThrottleDenial = 'RATE_LIMITED' | 'STORE_UNAVAILABLE';

/**
 * Redis burst + per-minute counters for MCP tool invocations (fail closed).
 */
@Injectable()
export class McpThrottleService {
  private readonly logger = new Logger(McpThrottleService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(mcpConfig.KEY)
    private readonly mcp: ConfigType<typeof mcpConfig>,
  ) {}

  /**
   * @returns null when admitted; otherwise why the invocation was refused.
   */
  async consume(userId: string): Promise<McpThrottleDenial | null> {
    try {
      const burstOk = await this.hit(
        `mcp:throttle:burst:u:${userId}`,
        this.mcp.throttle.burst.windowSeconds,
        this.mcp.throttle.burst.max,
      );
      if (!burstOk) {
        return 'RATE_LIMITED';
      }

      const minuteOk = await this.hit(
        `mcp:throttle:minute:u:${userId}`,
        this.mcp.throttle.minute.windowSeconds,
        this.mcp.throttle.minute.max,
      );
      if (!minuteOk) {
        return 'RATE_LIMITED';
      }

      return null;
    } catch (error: unknown) {
      this.logger.error(
        `MCP throttle store unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );

      /**
       * Fail closed — same posture as Nest throttling — but reported as its own
       * reason rather than as `RATE_LIMITED`. The refusal is identical; what
       * changes is that the caller is told this is temporary and unrelated to
       * their own request rate, and that the invocation log records an outage
       * rather than apparent abuse.
       */
      return 'STORE_UNAVAILABLE';
    }
  }

  private async hit(
    key: string,
    windowSeconds: number,
    max: number,
  ): Promise<boolean> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }
    return count <= max;
  }
}
