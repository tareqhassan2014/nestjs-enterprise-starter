import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

import { RequestContext } from '@common/context/request-context';
import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';
import { CurrentUser } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import { RequirePermissions } from '@modules/authorization/authorization.decorators';
import { CreditService } from '@modules/credits/credit.service';
import { PlanResolutionService } from '@modules/plans/plan-resolution.service';
import { StrictThrottle } from '@modules/throttling/throttle.decorators';
import { PrismaService } from '@infrastructure/prisma/prisma.service';

import {
  AUDIT_ACTIONS,
  AuditLogService,
} from './audit-log.service';

class LedgerQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class CreditGrantDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @IsString()
  @MinLength(1)
  idempotencyKey!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

class CreditAdjustDto {
  @Type(() => Number)
  @IsInt()
  delta!: number;

  @IsString()
  @MinLength(1)
  idempotencyKey!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

@ApiTags('Admin')
@Controller({ path: 'admin/users', version: '1' })
export class AdminBillingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanResolutionService,
    private readonly credits: CreditService,
    private readonly audit: AuditLogService,
  ) {}

  @Get(':userId/subscription')
  @RequirePermissions('admin:subscriptions:read')
  async subscription(@Param('userId') userId: string) {
    await this.requireUser(userId);
    const effective = await this.plans.resolve(userId);

    return {
      userId,
      plan: {
        slug: effective.slug,
        name: effective.name,
        rank: effective.rank,
      },
      fromSubscription: effective.fromSubscription,
      subscription:
        effective.subscriptionId && effective.status && effective.interval
          ? {
              id: effective.subscriptionId,
              status: effective.status,
              interval: effective.interval,
              currentPeriodEnd: effective.currentPeriodEnd,
            }
          : null,
      entitlements: { ...effective.entitlements },
      limits: Object.fromEntries(
        Object.entries(effective.usageLimits).map(([feature, ceilings]) => [
          feature,
          { daily: ceilings.daily, weekly: ceilings.weekly },
        ]),
      ),
    };
  }

  @Get(':userId/credits')
  @RequirePermissions('admin:credits:read')
  async creditsView(
    @Param('userId') userId: string,
    @Query() query: LedgerQueryDto,
  ) {
    await this.requireUser(userId);
    const balance = await this.credits.getBalance(userId);
    const entries = await this.credits.listLedger(userId, query.limit ?? 20);

    return {
      userId,
      balance,
      entries: entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        feature: entry.feature,
        idempotencyKey: entry.idempotencyKey,
        createdAt: entry.createdAt,
      })),
    };
  }

  @Post(':userId/credits/grant')
  @HttpCode(HttpStatus.OK)
  @StrictThrottle()
  @RequirePermissions('admin:credits:adjust')
  async grant(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('userId') userId: string,
    @Body() body: CreditGrantDto,
  ) {
    await this.requireUser(userId);

    const result = await this.credits.grant({
      userId,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      metadata: {
        actorUserId: actor.id,
        reason: body.reason,
      },
    });

    if (!result.replayed) {
      await this.audit.writeSafe({
        actorUserId: actor.id,
        action: AUDIT_ACTIONS.CREDITS_GRANT,
        targetType: 'user',
        targetId: userId,
        summary: `Granted ${body.amount} credits: ${body.reason}`,
        metadata: {
          amount: body.amount,
          idempotencyKey: body.idempotencyKey,
          balanceAfter: result.balance,
        },
        requestId: RequestContext.getRequestId(),
      });
    }

    return {
      userId,
      balance: result.balance,
      replayed: result.replayed,
      entry: {
        id: result.entry.id,
        type: result.entry.type,
        amount: result.entry.amount,
        balanceAfter: result.entry.balanceAfter,
      },
    };
  }

  @Post(':userId/credits/adjust')
  @HttpCode(HttpStatus.OK)
  @StrictThrottle()
  @RequirePermissions('admin:credits:adjust')
  async adjust(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('userId') userId: string,
    @Body() body: CreditAdjustDto,
  ) {
    await this.requireUser(userId);

    if (!Number.isInteger(body.delta) || body.delta === 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.BAD_REQUEST,
        'delta must be a non-zero integer.',
      );
    }

    const result = await this.credits.adjust({
      userId,
      delta: body.delta,
      idempotencyKey: body.idempotencyKey,
      metadata: {
        actorUserId: actor.id,
        reason: body.reason,
      },
    });

    if (!result.replayed) {
      await this.audit.writeSafe({
        actorUserId: actor.id,
        action: AUDIT_ACTIONS.CREDITS_ADJUST,
        targetType: 'user',
        targetId: userId,
        summary: `Adjusted credits by ${body.delta}: ${body.reason}`,
        metadata: {
          delta: body.delta,
          idempotencyKey: body.idempotencyKey,
          balanceAfter: result.balance,
        },
        requestId: RequestContext.getRequestId(),
      });
    }

    return {
      userId,
      balance: result.balance,
      replayed: result.replayed,
      entry: {
        id: result.entry.id,
        type: result.entry.type,
        amount: result.entry.amount,
        balanceAfter: result.entry.balanceAfter,
      },
    };
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'User not found.',
      );
    }
  }
}
