import type { AgentPrincipal } from '@modules/api-keys/api-key.service';
import type { CreditFeature } from '@modules/credits/credit-costs';
import type { Entitlement, PlanSlug } from '@modules/plans/entitlements';
import type { UsageFeature } from '@modules/usage-limits/usage-features';
import type { ZodRawShape } from 'zod';

export interface McpToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  /** Zod raw shape for MCP SDK inputSchema (object fields). */
  inputSchema?: ZodRawShape;
  permissions: readonly string[];
  entitlements?: readonly Entitlement[];
  minimumPlan?: PlanSlug;
  usageFeature?: UsageFeature;
  creditFeature?: CreditFeature;
  handler: (args: TArgs, principal: AgentPrincipal) => Promise<unknown>;
}
