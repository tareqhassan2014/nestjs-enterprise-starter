import { Module } from '@nestjs/common';

import { ApiKeysModule } from '@modules/api-keys/api-keys.module';

import { AgentPipeline } from './agent-pipeline.service';
import { McpController } from './mcp.controller';
import { McpInvocationLogService } from './mcp-invocation-log.service';
import { McpServerFactory } from './mcp-server.factory';
import { McpThrottleService } from './mcp-throttle.service';
import { McpToolCatalog } from './mcp-tool-catalog';

@Module({
  imports: [ApiKeysModule],
  controllers: [McpController],
  providers: [
    McpToolCatalog,
    McpServerFactory,
    AgentPipeline,
    McpThrottleService,
    McpInvocationLogService,
  ],
  exports: [AgentPipeline, McpInvocationLogService],
})
export class McpModule {}
