import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

import { RequirePermissions } from '@modules/authorization/authorization.decorators';

import { AuditLogService } from './audit-log.service';

class AuditListQueryDto {
  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

@ApiTags('Admin')
@Controller({ path: 'admin/audit', version: '1' })
@RequirePermissions('admin:audit:read')
export class AdminAuditController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  async list(@Query() query: AuditListQueryDto) {
    const result = await this.audit.list({
      action: query.action,
      actorUserId: query.actorUserId,
      targetId: query.targetId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      items: result.items.map((item) => ({
        id: item.id,
        actorUserId: item.actorUserId,
        action: item.action,
        targetType: item.targetType,
        targetId: item.targetId,
        summary: item.summary,
        metadata: item.metadata,
        requestId: item.requestId,
        createdAt: item.createdAt,
      })),
      limit: result.limit,
      offset: result.offset,
    };
  }
}
