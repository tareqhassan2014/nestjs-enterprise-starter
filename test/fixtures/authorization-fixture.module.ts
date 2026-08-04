import { Controller, Get, Module } from '@nestjs/common';

import { CurrentUser, Public } from '@modules/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '@modules/auth/auth.service';
import {
  RequirePermissions,
  RequireRoles,
} from '@modules/authorization/authorization.decorators';

/**
 * Routes that exist only to exercise the guard chain.
 *
 * Kept in the test tree rather than shipped: the assertions are about the
 * mechanism, and a starter should not carry demo endpoints a fork has to find and
 * delete.
 */
@Controller('authz-fixture')
export class AuthorizationFixtureController {
  /** No annotations at all — the deny-by-default case. */
  @Get('unannotated')
  unannotated(): { reached: true } {
    return { reached: true };
  }

  @Public()
  @Get('public')
  open(): { reached: true } {
    return { reached: true };
  }

  /** Authenticated is the only requirement. */
  @Get('authenticated')
  authenticated(@CurrentUser() user: AuthenticatedPrincipal): {
    id: string;
    email: string;
  } {
    return { id: user.id, email: user.email };
  }

  @RequirePermissions('account:read')
  @Get('own-account')
  ownAccount(): { reached: true } {
    return { reached: true };
  }

  @RequirePermissions('user:list')
  @Get('list-users')
  listUsers(): { reached: true } {
    return { reached: true };
  }

  /** Both are required, not either. */
  @RequirePermissions('user:list', 'role:manage')
  @Get('two-permissions')
  twoPermissions(): { reached: true } {
    return { reached: true };
  }

  /** Any one suffices. */
  @RequireRoles('admin', 'user')
  @Get('either-role')
  eitherRole(): { reached: true } {
    return { reached: true };
  }

  @RequireRoles('admin')
  @Get('admin-role')
  adminRole(): { reached: true } {
    return { reached: true };
  }

  /** Evaluates two requirements, to prove the access set resolves once. */
  @RequirePermissions('account:read', 'account:update')
  @Get('two-checks')
  twoChecks(): { reached: true } {
    return { reached: true };
  }
}

/**
 * Controller-level requirement, with one method overriding it — method-level
 * annotations must take precedence.
 */
@RequirePermissions('role:manage')
@Controller('authz-inherited')
export class InheritedRequirementController {
  /** Inherits `role:manage` from the controller. */
  @Get('inherits')
  inherits(): { reached: true } {
    return { reached: true };
  }

  /** Overrides it with a weaker requirement. */
  @RequirePermissions('account:read')
  @Get('overrides')
  overrides(): { reached: true } {
    return { reached: true };
  }
}

@Module({
  controllers: [AuthorizationFixtureController, InheritedRequirementController],
})
export class AuthorizationFixtureModule {}
