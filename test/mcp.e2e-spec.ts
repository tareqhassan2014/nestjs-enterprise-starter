import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Redis } from 'ioredis';
import request from 'supertest';

import { mcpConfig } from '@config/mcp.config';
import { observabilityConfig } from '@config/observability.config';
import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import { CreditService } from '@modules/credits/credit.service';
import { PermissionResolver } from '@modules/authorization/permission-resolver.service';
import { MetricsService } from '@modules/metrics/metrics.service';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  grantRole,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';

async function connectMcpClient(baseUrl: string, apiKey: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });
  const client = new Client({ name: 'e2e-mcp', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('Nest-hosted MCP (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let credits: CreditService;
  let resolver: PermissionResolver;
  let metrics: MetricsService;
  let redis: Redis;
  let baseUrl: string;
  let user: TestUser;
  let apiKeySecret: string;
  let apiKeyId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(observabilityConfig.KEY)
        .useValue({
          metricsEnabled: true,
          metricsBearerToken: undefined,
          swaggerEnabled: false,
          adminUsageTopN: 20,
        })
        .overrideProvider(mcpConfig.KEY)
        .useValue({
          enabled: true,
          path: '/mcp',
          throttle: {
            burst: { windowSeconds: 10, max: 100 },
            minute: { windowSeconds: 60, max: 500 },
          },
        }),
    );

    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    credits = app.get(CreditService);
    resolver = app.get(PermissionResolver);
    metrics = app.get(MetricsService);
    redis = app.get(REDIS_CLIENT);

    await clearAuthLimiterState(redis);
    // Clear MCP throttle keys from prior runs.
    const mcpKeys = await redis.keys('mcp:throttle:*');
    if (mcpKeys.length > 0) {
      await redis.del(...mcpKeys);
    }

    user = await createVerifiedUser({ app, prisma, mail }, 'mcp-agent');
    createdUserIds.push(user.userId);
    await grantRole(prisma, user.userId, 'user');
    await resolver.invalidate();

    await app.listen(0);
    baseUrl = await app.getUrl();

    const created = await request(app.getHttpServer())
      .post('/api/v1/account/api-keys')
      .set('Cookie', user.cookie)
      .send({ name: 'e2e-cursor' });

    expect(created.status).toBe(201);
    expect(created.body.success).toBe(true);
    apiKeySecret = created.body.data.secret as string;
    apiKeyId = created.body.data.id as string;
    expect(apiKeySecret).toMatch(/^nes_/);
  }, 90_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('rejects MCP without a valid API key', async () => {
    const response = await request(app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '1.0.0' },
        },
      });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/Unauthorized/i);
  });

  it('lists tools and invokes profile + balance with a valid key', async () => {
    const { client, transport } = await connectMcpClient(baseUrl, apiKeySecret);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'account.get_profile',
          'plans.get_current',
          'credits.get_balance',
          'credits.list_ledger',
          'usage.get_snapshot',
          'demo.paid_ping',
        ]),
      );

      const profile = await client.callTool({
        name: 'account.get_profile',
        arguments: {},
      });
      expect(profile.isError).toBeFalsy();
      const profileText = String(
        (profile.content as { type: string; text?: string }[])[0]?.text ?? '',
      );
      expect(profileText).toContain(user.userId);

      const balance = await client.callTool({
        name: 'credits.get_balance',
        arguments: {},
      });
      expect(balance.isError).toBeFalsy();

      const resources = await client.listResources();
      expect(resources.resources.some((r) => r.uri === 'starter://docs/mcp')).toBe(
        true,
      );

      const invocation = await prisma.mcpToolInvocation.findFirst({
        where: { userId: user.userId, toolName: 'account.get_profile' },
        orderBy: { createdAt: 'desc' },
      });
      expect(invocation?.outcome).toBe('success');
      expect(invocation?.apiKeyId).toBe(apiKeyId);

      const scrape = await metrics.scrape();
      expect(scrape).toContain('mcp_tool_invocations_total');
    } finally {
      await transport.close();
      await client.close();
    }
  });

  it('rejects a revoked API key', async () => {
    const revoke = await request(app.getHttpServer())
      .delete(`/api/v1/account/api-keys/${apiKeyId}`)
      .set('Cookie', user.cookie);
    expect(revoke.status).toBe(200);

    const response = await request(app.getHttpServer())
      .post('/mcp')
      .set('Authorization', `Bearer ${apiKeySecret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '1.0.0' },
        },
      });

    expect(response.status).toBe(401);

    // Recreate a key for later tests.
    const created = await request(app.getHttpServer())
      .post('/api/v1/account/api-keys')
      .set('Cookie', user.cookie)
      .send({ name: 'e2e-cursor-2' });
    apiKeySecret = created.body.data.secret as string;
    apiKeyId = created.body.data.id as string;
  });

  it('denies credit-gated tool without balance and does not spend', async () => {
    const before = await credits.getBalance(user.userId);
    expect(before).toBe(0);

    const { client, transport } = await connectMcpClient(baseUrl, apiKeySecret);
    try {
      const result = await client.callTool({
        name: 'demo.paid_ping',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = String(
        (result.content as { type: string; text?: string }[])[0]?.text ?? '',
      );
      expect(text).toMatch(/INSUFFICIENT_CREDITS/);

      const after = await credits.getBalance(user.userId);
      expect(after).toBe(0);

      const denied = await prisma.mcpToolInvocation.findFirst({
        where: {
          userId: user.userId,
          toolName: 'demo.paid_ping',
          outcome: 'denied',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(denied?.errorCode).toBe('INSUFFICIENT_CREDITS');
    } finally {
      await transport.close();
      await client.close();
    }
  });

  it('spends credits and meters usage when demo.paid_ping succeeds', async () => {
    await credits.grant({
      userId: user.userId,
      amount: 5,
      idempotencyKey: `mcp-e2e-grant-${user.userId}`,
    });

    const { client, transport } = await connectMcpClient(baseUrl, apiKeySecret);
    try {
      const result = await client.callTool({
        name: 'demo.paid_ping',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();

      const balance = await credits.getBalance(user.userId);
      expect(balance).toBe(4);

      const snapshots = await request(app.getHttpServer())
        .get('/api/v1/account/me')
        .set('Cookie', user.cookie);
      expect(snapshots.status).toBe(200);
    } finally {
      await transport.close();
      await client.close();
    }
  });

  it('rate-limits when MCP burst ceiling is forced low', async () => {
    // Override is already baked into the app; drive throttle by rewriting Redis
    // counters via a temporary low-ceiling override through redis keys.
    // Use a fresh key and a dedicated pipeline call by temporarily exhausting
    // the burst window for this user.
    const burstKey = `mcp:throttle:burst:u:${user.userId}`;
    await redis.set(burstKey, '100', 'EX', 10);

    const { client, transport } = await connectMcpClient(baseUrl, apiKeySecret);
    try {
      const result = await client.callTool({
        name: 'credits.get_balance',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = String(
        (result.content as { type: string; text?: string }[])[0]?.text ?? '',
      );
      expect(text).toMatch(/RATE_LIMITED/);
    } finally {
      await redis.del(burstKey);
      await transport.close();
      await client.close();
    }
  });
});
