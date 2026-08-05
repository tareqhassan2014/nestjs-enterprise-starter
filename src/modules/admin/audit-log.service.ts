import { Injectable, Logger } from '@nestjs/common';
import type { AdminAuditLog, Prisma } from '@/generated/prisma/client';

import { PrismaService } from '@infrastructure/prisma/prisma.service';

export const AUDIT_ACTIONS = {
  CREDITS_GRANT: 'credits.grant',
  CREDITS_ADJUST: 'credits.adjust',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

export interface WriteAuditParams {
  actorUserId: string;
  action: AuditAction | string;
  targetType?: string;
  targetId?: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
  requestId?: string | null;
}

export interface ListAuditParams {
  action?: string;
  actorUserId?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async write(params: WriteAuditParams): Promise<AdminAuditLog> {
    return this.prisma.adminAuditLog.create({
      data: {
        actorUserId: params.actorUserId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        summary: params.summary,
        metadata: params.metadata,
        requestId: params.requestId ?? undefined,
      },
    });
  }

  /**
   * Best-effort audit after a successful privileged mutation. Ledger success
   * must not roll back if this fails — log loudly for operator reconciliation.
   */
  async writeSafe(params: WriteAuditParams): Promise<void> {
    try {
      await this.write(params);
    } catch (error) {
      this.logger.error(
        {
          msg: 'Failed to persist admin audit row after successful mutation',
          action: params.action,
          actorUserId: params.actorUserId,
          targetId: params.targetId,
          requestId: params.requestId,
        },
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async list(params: ListAuditParams = {}): Promise<{
    items: AdminAuditLog[];
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(
      Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const offset = Math.max(params.offset ?? 0, 0);

    const where: Prisma.AdminAuditLogWhereInput = {};
    if (params.action) {
      where.action = params.action;
    }
    if (params.actorUserId) {
      where.actorUserId = params.actorUserId;
    }
    if (params.targetId) {
      where.targetId = params.targetId;
    }
    if (params.from || params.to) {
      where.createdAt = {
        ...(params.from ? { gte: params.from } : {}),
        ...(params.to ? { lte: params.to } : {}),
      };
    }

    const items = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return { items, limit, offset };
  }
}
