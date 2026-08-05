import { registerAs } from '@nestjs/config';

import { normalizeMcpPath } from '@common/http/mcp-routes';

import { getEnv } from './env.validation';

/**
 * Nest-hosted MCP transport and agent throttle ceilings.
 */
export const mcpConfig = registerAs('mcp', () => {
  const env = getEnv();

  return {
    enabled: env.MCP_ENABLED,
    path: normalizeMcpPath(env.MCP_PATH),
    throttle: {
      burst: {
        windowSeconds: env.MCP_THROTTLE_BURST_WINDOW_SECONDS,
        max: env.MCP_THROTTLE_BURST_MAX,
      },
      minute: {
        windowSeconds: env.MCP_THROTTLE_MINUTE_WINDOW_SECONDS,
        max: env.MCP_THROTTLE_MINUTE_MAX,
      },
    },
  };
});

export type McpConfig = ReturnType<typeof mcpConfig>;
