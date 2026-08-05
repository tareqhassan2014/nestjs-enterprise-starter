import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { RequestContext } from '@common/context/request-context';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import type { AgentPrincipal } from '@modules/api-keys/api-key.service';
import { type CreditFeature, creditCost } from '@modules/credits/credit-costs';
import { CreditService } from '@modules/credits/credit.service';
import { MetricsService } from '@modules/metrics/metrics.service';
import type { Entitlement, PlanSlug } from '@modules/plans/entitlements';
import { PlanResolutionService } from '@modules/plans/plan-resolution.service';
import type { UsageFeature } from '@modules/usage-limits/usage-features';
import { UsageLimitsService } from '@modules/usage-limits/usage-limits.service';

import { McpInvocationLogService } from './mcp-invocation-log.service';
import { McpThrottleService } from './mcp-throttle.service';
import type { McpToolDefinition } from './mcp-tool.types';

export interface AgentPipelineRunParams<TArgs> {
  principal: AgentPrincipal;
  tool: McpToolDefinition<TArgs>;
  args: TArgs;
  requestId?: string | null;
}

@Injectable()
export class AgentPipeline {
  private readonly logger = new Logger(AgentPipeline.name);

  constructor(
    private readonly plans: PlanResolutionService,
    private readonly throttle: McpThrottleService,
    private readonly usage: UsageLimitsService,
    private readonly credits: CreditService,
    private readonly invocations: McpInvocationLogService,
    private readonly metrics: MetricsService,
  ) {}

  async run<TArgs, TResult>(
    params: AgentPipelineRunParams<TArgs>,
  ): Promise<TResult> {
    const { principal, tool, args } = params;
    const requestId =
      params.requestId ?? RequestContext.getRequestId() ?? undefined;

    try {
      this.assertPermissions(principal, tool.permissions);

      if (tool.entitlements?.length || tool.minimumPlan) {
        await this.assertPlan(principal.user.id, tool);
      }

      const limited = await this.throttle.consume(principal.user.id);
      if (limited) {
        throw new ApiException(
          HttpStatus.TOO_MANY_REQUESTS,
          ErrorCode.RATE_LIMITED,
          'Too many MCP requests. Try again later.',
        );
      }

      if (tool.usageFeature) {
        await this.usage.consume(
          { userId: principal.user.id },
          tool.usageFeature,
        );
      }

      let spendKey: string | undefined;
      if (tool.creditFeature) {
        const amount = creditCost(tool.creditFeature);
        spendKey = `mcp:spend:${requestId ?? 'noreq'}:${tool.name}:${tool.creditFeature}`;
        try {
          await this.credits.spend({
            userId: principal.user.id,
            amount,
            idempotencyKey: spendKey,
            feature: tool.creditFeature,
          });
        } catch (error: unknown) {
          if (
            error instanceof ApiException &&
            error.code === ErrorCode.INSUFFICIENT_CREDITS
          ) {
            throw error;
          }
          // CreditService may throw ApiException or a domain error — rethrow known.
          throw error;
        }
      }

      try {
        const result = (await tool.handler(args, principal)) as TResult;
        await this.finish('success', principal, tool.name, requestId);
        return result;
      } catch (error: unknown) {
        if (tool.creditFeature && spendKey) {
          await this.credits
            .refund({
              userId: principal.user.id,
              amount: creditCost(tool.creditFeature),
              idempotencyKey: `mcp:refund:${spendKey}`,
              feature: tool.creditFeature,
            })
            .catch((refundError: unknown) => {
              this.logger.error(
                `MCP credit refund failed: ${refundError instanceof Error ? refundError.message : String(refundError)}`,
              );
            });
        }
        throw error;
      }
    } catch (error: unknown) {
      const code =
        error instanceof ApiException ? error.code : ErrorCode.INTERNAL_ERROR;
      const outcome =
        error instanceof ApiException &&
        (error.code === ErrorCode.FORBIDDEN ||
          error.code === ErrorCode.UNAUTHORIZED ||
          error.code === ErrorCode.ENTITLEMENT_DENIED ||
          error.code === ErrorCode.RATE_LIMITED ||
          error.code === ErrorCode.USAGE_LIMIT_EXCEEDED ||
          error.code === ErrorCode.INSUFFICIENT_CREDITS)
          ? 'denied'
          : 'error';

      await this.finish(outcome, principal, tool.name, requestId, code);
      throw error;
    }
  }

  private assertPermissions(
    principal: AgentPrincipal,
    required: readonly string[],
  ): void {
    const missing = required.filter(
      (permission) => !principal.access.permissions.includes(permission),
    );
    if (missing.length > 0) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'You do not have access to this resource.',
      );
    }
  }

  private async assertPlan(
    userId: string,
    tool: Pick<McpToolDefinition<unknown>, 'entitlements' | 'minimumPlan'>,
  ): Promise<void> {
    const plan = await this.plans.resolve(userId);

    if (
      tool.minimumPlan &&
      !this.plans.meetsMinimumPlan(plan, tool.minimumPlan)
    ) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.ENTITLEMENT_DENIED,
        'Your plan does not include this capability.',
      );
    }

    for (const key of tool.entitlements ?? []) {
      if (!this.plans.hasEntitlement(plan, key)) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          ErrorCode.ENTITLEMENT_DENIED,
          'Your plan does not include this capability.',
        );
      }
    }
  }

  private async finish(
    outcome: 'success' | 'denied' | 'error',
    principal: AgentPrincipal,
    toolName: string,
    requestId: string | undefined,
    errorCode?: string,
  ): Promise<void> {
    this.metrics.recordMcpToolInvocation(toolName, outcome);
    await this.invocations.record({
      userId: principal.user.id,
      apiKeyId: principal.apiKeyId,
      toolName,
      outcome,
      errorCode,
      requestId,
    });
  }
}

// Re-export types used by tool definitions for convenience.
export type { CreditFeature, PlanSlug, UsageFeature, Entitlement };
