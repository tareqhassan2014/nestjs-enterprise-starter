import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '@infrastructure/prisma/prisma.service';

export type McpInvocationOutcome = 'success' | 'denied' | 'error';

export interface RecordMcpInvocationParams {
  userId: string;
  apiKeyId: string;
  toolName: string;
  outcome: McpInvocationOutcome;
  errorCode?: string;
  requestId?: string | null;
}

@Injectable()
export class McpInvocationLogService {
  private readonly logger = new Logger(McpInvocationLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(params: RecordMcpInvocationParams): Promise<void> {
    try {
      await this.prisma.mcpToolInvocation.create({
        data: {
          userId: params.userId,
          apiKeyId: params.apiKeyId,
          toolName: params.toolName,
          outcome: params.outcome,
          errorCode: params.errorCode,
          requestId: params.requestId ?? undefined,
        },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Failed to persist MCP invocation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
