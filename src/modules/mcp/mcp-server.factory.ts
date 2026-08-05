import { Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ApiException } from '@common/errors/api-exception';
import type { AgentPrincipal } from '@modules/api-keys/api-key.service';

import { AgentPipeline } from './agent-pipeline.service';
import { McpToolCatalog } from './mcp-tool-catalog';

const CONNECTION_DOCS = `# Connect an MCP client

Base URL: \`{APP_URL}{MCP_PATH}\` (default \`/mcp\`).

Authentication: \`Authorization: Bearer <api_key>\`

Create a key while signed in:

\`POST /api/v1/account/api-keys\` with body \`{ "name": "Cursor" }\`.

The plaintext secret is returned **once**. Store it in your MCP client config.

Cursor / Claude / ChatGPT: use the Streamable HTTP MCP URL and the Bearer header.
Session cookies are not accepted on this channel.
`;

@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger(McpServerFactory.name);

  constructor(
    private readonly catalog: McpToolCatalog,
    private readonly pipeline: AgentPipeline,
  ) {}

  create(principal: AgentPrincipal, requestId?: string | null): McpServer {
    const server = new McpServer({
      name: 'nestjs-enterprise-starter',
      version: '1.0.0',
    });

    for (const tool of this.catalog.tools()) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        async (args) => {
          try {
            const result = await this.pipeline.run({
              principal,
              tool,
              args: args ?? {},
              requestId,
            });

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
              structuredContent:
                result && typeof result === 'object'
                  ? (result as Record<string, unknown>)
                  : { value: result },
            };
          } catch (error: unknown) {
            const message =
              error instanceof ApiException
                ? `${error.code}: ${error.message}`
                : error instanceof Error
                  ? error.message
                  : 'Tool invocation failed';

            this.logger.warn({
              msg: 'MCP tool failed',
              tool: tool.name,
              userId: principal.user.id,
              message,
            });

            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: message,
                },
              ],
            };
          }
        },
      );
    }

    server.registerResource(
      'mcp-connection-docs',
      'starter://docs/mcp',
      {
        description:
          'How to connect Cursor, Claude, and ChatGPT to this server',
        mimeType: 'text/markdown',
      },
      () =>
        Promise.resolve({
          contents: [
            {
              uri: 'starter://docs/mcp',
              mimeType: 'text/markdown',
              text: CONNECTION_DOCS,
            },
          ],
        }),
    );

    return server;
  }
}
