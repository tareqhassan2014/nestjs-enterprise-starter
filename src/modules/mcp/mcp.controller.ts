import {
  All,
  Controller,
  Inject,
  Logger,
  NotFoundException,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { NoEnvelope } from '@common/decorators/no-envelope.decorator';
import { RequestContext } from '@common/context/request-context';
import { mcpConfig } from '@config/mcp.config';
import { OPENAPI_API_KEY } from '@infrastructure/openapi/openapi.document';
import { ApiKeyService } from '@modules/api-keys/api-key.service';
import { Public } from '@modules/auth/auth.decorators';

import { McpServerFactory } from './mcp-server.factory';

/**
 * Nest-hosted MCP Streamable HTTP transport.
 *
 * Outside `/api`, outside the success envelope. Auth is Bearer API key only
 * (Better Auth sessions are not accepted here). Nest throttling is skipped;
 * MCP-specific Redis ceilings run inside AgentPipeline.
 *
 * Excluded from OpenAPI path items (Streamable HTTP is not an enveloped Nest
 * JSON API); `api_key` is still declared as a document security scheme and
 * referenced here for tooling that inspects controller metadata.
 */
@ApiTags('MCP')
@ApiBearerAuth(OPENAPI_API_KEY)
@ApiExcludeController()
@Public()
@SkipThrottle({ burst: true, minute: true })
@NoEnvelope()
@Controller({ path: 'mcp', version: VERSION_NEUTRAL })
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    @Inject(mcpConfig.KEY)
    private readonly mcp: ConfigType<typeof mcpConfig>,
    private readonly apiKeys: ApiKeyService,
    private readonly servers: McpServerFactory,
  ) {}

  @All()
  async handle(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.mcp.enabled) {
      throw new NotFoundException();
    }

    if (this.mcp.path !== '/mcp') {
      this.logger.warn(
        `MCP_PATH is ${this.mcp.path} but the Nest controller is fixed at /mcp`,
      );
    }

    const principal = await this.apiKeys.authenticateBearer(
      request.headers.authorization,
    );

    if (!principal) {
      response.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: valid API key Bearer token required',
        },
        id: null,
      });
      return;
    }

    RequestContext.setUserId(principal.user.id);

    const server = this.servers.create(
      principal,
      RequestContext.getRequestId(),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error: unknown) {
      this.logger.error(
        `MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
    }
  }
}
