import { HttpStatus } from '@nestjs/common';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

import { AgentPipeline } from './agent-pipeline.service';
import type { McpToolDefinition } from './mcp-tool.types';

function buildPipeline(overrides?: {
  consumeUsage?: jest.Mock;
  spend?: jest.Mock;
  throttle?: jest.Mock;
}) {
  const plans = {
    resolve: jest.fn(),
    meetsMinimumPlan: jest.fn().mockReturnValue(true),
    hasEntitlement: jest.fn().mockReturnValue(true),
  };
  const throttle = {
    consume: overrides?.throttle ?? jest.fn().mockResolvedValue(null),
  };
  const usage = {
    consume: overrides?.consumeUsage ?? jest.fn().mockResolvedValue(undefined),
  };
  const credits = {
    spend: overrides?.spend ?? jest.fn().mockResolvedValue({ replayed: false }),
    refund: jest.fn().mockResolvedValue({}),
  };
  const invocations = { record: jest.fn().mockResolvedValue(undefined) };
  const metrics = { recordMcpToolInvocation: jest.fn() };

  const pipeline = new AgentPipeline(
    plans as never,
    throttle as never,
    usage as never,
    credits as never,
    invocations as never,
    metrics as never,
  );

  return { pipeline, plans, throttle, usage, credits, invocations, metrics };
}

const principal = {
  apiKeyId: 'key-1',
  access: { roles: ['user'], permissions: ['mcp:tools:invoke'] },
  user: {
    id: 'user-1',
    email: 'a@example.com',
    name: 'A',
    emailVerified: true,
    twoFactorEnabled: false,
  },
};

describe('AgentPipeline', () => {
  it('denies when permission is missing', async () => {
    const { pipeline, credits, invocations, metrics } = buildPipeline();
    const handler = jest.fn();
    const tool: McpToolDefinition = {
      name: 'account.get_profile',
      description: 'x',
      permissions: ['mcp:tools:invoke', 'account:read'],
      handler,
    };

    await expect(
      pipeline.run({ principal, tool, args: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    expect(handler).not.toHaveBeenCalled();
    expect(credits.spend).not.toHaveBeenCalled();
    expect(invocations.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'denied', toolName: tool.name }),
    );
    expect(metrics.recordMcpToolInvocation).toHaveBeenCalledWith(
      tool.name,
      'denied',
    );
  });

  it('denies when usage ceiling is hit before adapter', async () => {
    const { pipeline } = buildPipeline({
      consumeUsage: jest
        .fn()
        .mockRejectedValue(
          new ApiException(
            HttpStatus.TOO_MANY_REQUESTS,
            ErrorCode.USAGE_LIMIT_EXCEEDED,
            'Usage exceeded',
          ),
        ),
    });
    const handler = jest.fn();
    const tool: McpToolDefinition = {
      name: 'demo.paid_ping',
      description: 'x',
      permissions: ['mcp:tools:invoke'],
      usageFeature: 'demo',
      handler,
    };

    await expect(
      pipeline.run({
        principal: {
          ...principal,
          access: { roles: ['user'], permissions: ['mcp:tools:invoke'] },
        },
        tool,
        args: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCode.USAGE_LIMIT_EXCEEDED });
    expect(handler).not.toHaveBeenCalled();
  });

  it('denies insufficient credits before adapter', async () => {
    const { pipeline, credits } = buildPipeline({
      spend: jest
        .fn()
        .mockRejectedValue(
          new ApiException(
            HttpStatus.PAYMENT_REQUIRED,
            ErrorCode.INSUFFICIENT_CREDITS,
            'Insufficient credits.',
          ),
        ),
    });
    const handler = jest.fn();
    const tool: McpToolDefinition = {
      name: 'demo.paid_ping',
      description: 'x',
      permissions: ['mcp:tools:invoke'],
      creditFeature: 'demo.paid',
      handler,
    };

    await expect(
      pipeline.run({ principal, tool, args: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_CREDITS });
    expect(handler).not.toHaveBeenCalled();
    expect(credits.spend).toHaveBeenCalled();
  });

  it('invokes adapter once on happy path', async () => {
    const { pipeline, invocations, metrics } = buildPipeline();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    const tool: McpToolDefinition = {
      name: 'credits.get_balance',
      description: 'x',
      permissions: ['mcp:tools:invoke'],
      handler,
    };

    await expect(pipeline.run({ principal, tool, args: {} })).resolves.toEqual({
      ok: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(invocations.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success' }),
    );
    expect(metrics.recordMcpToolInvocation).toHaveBeenCalledWith(
      tool.name,
      'success',
    );
  });

  it('denies when MCP throttle is exceeded', async () => {
    const { pipeline } = buildPipeline({
      throttle: jest.fn().mockResolvedValue('RATE_LIMITED'),
    });
    const handler = jest.fn();
    const tool: McpToolDefinition = {
      name: 'credits.get_balance',
      description: 'x',
      permissions: ['mcp:tools:invoke'],
      handler,
    };

    await expect(
      pipeline.run({ principal, tool, args: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    expect(handler).not.toHaveBeenCalled();
  });
});
