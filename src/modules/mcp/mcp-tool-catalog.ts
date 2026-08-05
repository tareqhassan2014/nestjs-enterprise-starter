import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { AgentPrincipal } from '@modules/api-keys/api-key.service';
import { PermissionResolver } from '@modules/authorization/permission-resolver.service';
import { CreditService } from '@modules/credits/credit.service';
import { PlanResolutionService } from '@modules/plans/plan-resolution.service';
import {
  USAGE_FEATURE_LIST,
  USAGE_FEATURES,
} from '@modules/usage-limits/usage-features';
import { UsageLimitsService } from '@modules/usage-limits/usage-limits.service';

import type { McpToolDefinition } from './mcp-tool.types';

@Injectable()
export class McpToolCatalog {
  constructor(
    private readonly permissions: PermissionResolver,
    private readonly plans: PlanResolutionService,
    private readonly credits: CreditService,
    private readonly usage: UsageLimitsService,
  ) {}

  /** Starter catalog — thin adapters over existing domain services. */
  tools(): McpToolDefinition[] {
    return [
      {
        name: 'account.get_profile',
        description:
          'Return the authenticated user profile, roles, and permissions.',
        permissions: ['mcp:tools:invoke', 'account:read'],
        handler: async (_args, principal) => this.profile(principal),
      },
      {
        name: 'plans.get_current',
        description:
          'Return the caller’s effective plan and subscription summary.',
        permissions: ['mcp:tools:invoke'],
        handler: async (_args, principal) => this.currentPlan(principal),
      },
      {
        name: 'credits.get_balance',
        description: 'Return the caller’s credit wallet balance.',
        permissions: ['mcp:tools:invoke'],
        handler: async (_args, principal) => ({
          balance: await this.credits.getBalance(principal.user.id),
        }),
      },
      {
        name: 'credits.list_ledger',
        description:
          'Return a bounded page of the caller’s credit ledger entries.',
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Page size (1–100)'),
        },
        permissions: ['mcp:tools:invoke'],
        handler: async (args, principal) => {
          const limit =
            typeof args === 'object' &&
            args &&
            'limit' in args &&
            typeof (args as { limit?: unknown }).limit === 'number'
              ? (args as { limit: number }).limit
              : 20;
          const entries = await this.credits.listLedger(
            principal.user.id,
            limit,
          );
          return { entries };
        },
      },
      {
        name: 'usage.get_snapshot',
        description:
          'Return daily/weekly usage snapshots for catalogue features (or one feature).',
        inputSchema: {
          feature: z
            .enum([USAGE_FEATURES.DEMO])
            .optional()
            .describe('Optional catalogue feature id'),
        },
        permissions: ['mcp:tools:invoke'],
        handler: async (args, principal) => {
          const feature =
            typeof args === 'object' &&
            args &&
            'feature' in args &&
            typeof (args as { feature?: unknown }).feature === 'string'
              ? (args as { feature: (typeof USAGE_FEATURE_LIST)[number] })
                  .feature
              : undefined;
          const snapshots = await this.usage.snapshotsForUser(
            principal.user.id,
            feature,
          );
          return { snapshots };
        },
      },
      {
        name: 'demo.paid_ping',
        description:
          'Demo credit-gated tool (costs demo.paid credits and meters the demo usage feature).',
        permissions: ['mcp:tools:invoke'],
        usageFeature: USAGE_FEATURES.DEMO,
        creditFeature: 'demo.paid',
        handler: (_args, principal) =>
          Promise.resolve({
            ok: true as const,
            userId: principal.user.id,
            feature: 'demo.paid' as const,
          }),
      },
    ];
  }

  private async profile(principal: AgentPrincipal) {
    const access = await this.permissions.resolve(principal.user.id);
    return {
      id: principal.user.id,
      email: principal.user.email,
      name: principal.user.name,
      emailVerified: principal.user.emailVerified,
      twoFactorEnabled: principal.user.twoFactorEnabled,
      roles: access.roles,
      permissions: access.permissions,
    };
  }

  private async currentPlan(principal: AgentPrincipal) {
    const effective = await this.plans.resolve(principal.user.id);
    return {
      plan: {
        slug: effective.slug,
        name: effective.name,
        rank: effective.rank,
      },
      fromSubscription: effective.fromSubscription,
      subscription: effective.subscriptionId
        ? {
            id: effective.subscriptionId,
            status: effective.status,
            interval: effective.interval,
            currentPeriodEnd: effective.currentPeriodEnd,
          }
        : null,
      entitlements: effective.entitlements,
      limits: Object.fromEntries(
        Object.entries(effective.usageLimits).map(([feature, ceilings]) => [
          feature,
          { daily: ceilings.daily, weekly: ceilings.weekly },
        ]),
      ),
    };
  }
}
