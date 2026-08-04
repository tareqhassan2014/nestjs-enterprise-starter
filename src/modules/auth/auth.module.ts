import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { authConfig, securityConfig } from '@config/index';
import { MailerService } from '@infrastructure/mail/mailer.service';
import { PrismaService } from '@infrastructure/prisma/prisma.service';

import { AccountController } from './account.controller';
import { AccountLockoutService } from './account-lockout.service';
import { createAuth } from './auth.factory';
import { AuthService } from './auth.service';
import { AUTH_INSTANCE } from './auth.tokens';
import { BetterAuthMiddleware } from './better-auth.middleware';
import { RedisSecondaryStorage } from './redis-secondary-storage';
import { TwoFactorController } from './two-factor.controller';

/**
 * Owns the Better Auth instance and the pieces that read it.
 *
 * Global because the guards registered here apply to every route, and because
 * feature modules need `AuthService` without importing this module explicitly.
 */
@Global()
@Module({
  providers: [
    RedisSecondaryStorage,
    AccountLockoutService,
    {
      provide: AUTH_INSTANCE,
      inject: [
        PrismaService,
        MailerService,
        RedisSecondaryStorage,
        AccountLockoutService,
        authConfig.KEY,
        securityConfig.KEY,
      ],
      useFactory: (
        prisma: PrismaService,
        mailer: MailerService,
        secondaryStorage: RedisSecondaryStorage,
        lockout: AccountLockoutService,
        auth: ConfigType<typeof authConfig>,
        security: ConfigType<typeof securityConfig>,
      ) =>
        createAuth({
          prisma,
          mailer,
          secondaryStorage,
          lockout,
          auth,
          security,
        }),
    },
    AuthService,
    BetterAuthMiddleware,
  ],
  controllers: [AccountController, TwoFactorController],
  exports: [
    AUTH_INSTANCE,
    AuthService,
    AccountLockoutService,
    BetterAuthMiddleware,
  ],
})
export class AuthModule {}
