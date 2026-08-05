import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from '@modules/auth/auth.guard';

import { PermissionResolver } from './permission-resolver.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * The access-control chain, registered globally.
 *
 * ORDER IS THE CONTRACT. Nest applies `APP_GUARD` providers in declaration
 * order, and each stage depends on the one before it:
 *
 *   1. `AuthGuard`           — establishes the principal, or rejects. Writes it
 *                              to the request and the request context.
 *   2. `PermissionsGuard`    — decides whether that principal may proceed.
 *   3. `EntitlementsGuard`   — commercial plan gates (registered in PlansModule)
 *   4. `AppThrottlerGuard`   — Nest burst/per-minute (registered in ThrottlingModule)
 *   5. `UsageLimitsGuard`    — optional `@UsageLimit` (registered in UsageLimitsModule)
 *   6. reserved: credit checks
 *
 * Stages 3–5 live in modules imported **after** this one in `AppModule`, so Nest
 * appends their `APP_GUARD` providers after Auth and Permissions. Each stage must
 * **consume the principal `AuthGuard` already resolved** rather than resolving
 * the session again — one resolution per request is what keeps the cost of the
 * chain flat as it grows, and what keeps a single request from observing two
 * different principals.
 *
 * Registered as providers rather than via `app.useGlobalGuards()` so that any app
 * built through `Test.createTestingModule` gets the same posture as the server.
 * This mirrors how the platform foundation registered its pipe, filter, and
 * interceptor, and for the same reason.
 */
@Global()
@Module({
  providers: [
    PermissionResolver,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [PermissionResolver],
})
export class AuthorizationModule {}
