import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { ApiSessionAuth } from '@infrastructure/openapi/api-session-auth.decorator';
import { RequirePermissions } from '@modules/authorization/authorization.decorators';
import { MetricsService } from '@modules/metrics/metrics.service';
import {
  isUsageFeature,
  type UsageFeature,
} from '@modules/usage-limits/usage-features';
import { UsageLimitsService } from '@modules/usage-limits/usage-limits.service';

import { RateLimitObservationsService } from './rate-limit-observations.service';

class Top429QueryDto {
  @IsOptional()
  @IsIn(['RATE_LIMITED', 'USAGE_LIMIT_EXCEEDED'])
  code?: 'RATE_LIMITED' | 'USAGE_LIMIT_EXCEEDED' = 'RATE_LIMITED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class UsageSnapshotQueryDto {
  @IsOptional()
  @IsString()
  feature?: string;
}

@ApiTags('Admin')
@ApiSessionAuth()
@Controller({ path: 'admin/usage', version: '1' })
@RequirePermissions('admin:metrics:read')
export class AdminUsageController {
  constructor(
    private readonly usage: UsageLimitsService,
    private readonly observations: RateLimitObservationsService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('pressure')
  async pressure() {
    const summary = await this.metrics.requestPressureSummary();
    return {
      ...summary,
      note: 'Totals since process start; use Prometheus rates for RPM.',
    };
  }

  @Get('top-429')
  async top429(@Query() query: Top429QueryDto) {
    const code = query.code ?? 'RATE_LIMITED';
    const [subjects, routes] = await Promise.all([
      this.observations.topSubjects(code, query.limit),
      this.observations.topRoutes(code, query.limit),
    ]);
    return { code, subjects, routes };
  }

  @Get('users/:userId')
  async userUsage(
    @Param('userId') userId: string,
    @Query() query: UsageSnapshotQueryDto,
  ) {
    let feature: UsageFeature | undefined;
    if (query.feature) {
      if (!isUsageFeature(query.feature)) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.BAD_REQUEST,
          `Unknown usage feature "${query.feature}".`,
        );
      }
      feature = query.feature;
    }

    const snapshots = await this.usage.snapshotsForUser(userId, feature);
    return { userId, snapshots };
  }
}
