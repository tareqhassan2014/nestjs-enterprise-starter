import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { mcpConfig } from '@config/mcp.config';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

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
   * @returns null when admitted; otherwise a RATE_LIMITED denial reason.
   */
  async consume(userId: string): Promise<'RATE_LIMITED' | null> {
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
      // Fail closed — same posture as Nest throttling.
      return 'RATE_LIMITED';
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
