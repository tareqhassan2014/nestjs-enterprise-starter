import type { ConfigType } from '@nestjs/config';
import { APIError, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthMiddleware } from 'better-auth/api';
import { bearer } from 'better-auth/plugins/bearer';
import { twoFactor } from 'better-auth/plugins/two-factor';

import type { authConfig, securityConfig } from '@config/index';
import type { MailerService } from '@infrastructure/mail/mailer.service';
import type { PrismaService } from '@infrastructure/prisma/prisma.service';

import type { AccountLockoutService } from './account-lockout.service';
import { CLIENT_IP_HEADER } from './client-ip';
import type { RedisSecondaryStorage } from './redis-secondary-storage';

export interface AuthFactoryDependencies {
  prisma: PrismaService;
  mailer: MailerService;
  secondaryStorage: RedisSecondaryStorage;
  lockout: AccountLockoutService;
  auth: ConfigType<typeof authConfig>;
  security: ConfigType<typeof securityConfig>;
}

/** Credential paths that get the stricter limit and the lockout hook. */
const SIGN_IN_PATHS = ['/sign-in/email'];

const STRICT_RATE_LIMIT_PATHS = [
  '/sign-in/email',
  '/sign-up/email',
  '/request-password-reset',
  '/forget-password',
  '/reset-password',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
];

function minutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * Builds the Better Auth instance from validated configuration.
 *
 * A plain function rather than a Nest provider body so it can be constructed in
 * a test with hand-made dependencies, and so its return type stays fully
 * inferred — `auth.api.*` is generated from these options, and widening it to an
 * interface would lose every endpoint's signature.
 */
export function createAuth({
  prisma,
  mailer,
  secondaryStorage,
  lockout,
  auth,
  security,
}: AuthFactoryDependencies) {
  return betterAuth({
    appName: 'nestjs-enterprise-starter',

    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    secret: auth.secret,
    baseURL: auth.appUrl,
    basePath: auth.basePath,

    /**
     * Shares the CORS allowlist, so the origin check and CORS cannot disagree.
     * Better Auth already trusts `baseURL`'s own origin.
     */
    trustedOrigins: security.corsOrigins,

    secondaryStorage,

    session: {
      expiresIn: auth.session.expiresInSeconds,
      updateAge: auth.session.updateAgeSeconds,

      /**
       * These two are load-bearing, and their defaults are the opposite of what
       * this application needs. With `secondaryStorage` set, Better Auth stores
       * sessions in Redis *only* and reads always go there — so an eviction
       * would sign everyone out.
       *
       * `storeSessionInDatabase: true` keeps Postgres authoritative;
       * `preserveSessionInDatabase: false` is what enables the fall-through on a
       * cache miss (the library returns null early when it is true) and ensures
       * revocation deletes the row rather than orphaning it.
       *
       * Verified against the read path in
       * `better-auth/dist/db/internal-adapter.mjs`. See design.md decision 3.
       */
      storeSessionInDatabase: true,
      preserveSessionInDatabase: false,

      /**
       * Deliberately NOT enabling `cookieCache`. It would remove the Redis read
       * too, but it hands the session to the client in a signed cookie for its
       * lifetime, so a revoked session keeps working until that window expires.
       * Database sessions were chosen for revocability; buying latency by giving
       * that back is the wrong default here. A fork that wants it should read the
       * revocation-lag note in the README first.
       */
    },

    emailAndPassword: {
      enabled: true,

      /** No session until the address is verified. */
      requireEmailVerification: true,

      minPasswordLength: auth.password.minLength,
      maxPasswordLength: auth.password.maxLength,

      resetPasswordTokenExpiresIn: auth.tokens.resetTtlSeconds,

      /** A reset is a credential change: existing sessions must not survive it. */
      revokeSessionsOnPasswordReset: true,

      sendResetPassword: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          subject: 'Reset your password',
          text: [
            'We received a request to reset your password.',
            '',
            'Open this link to choose a new one:',
            url,
            '',
            `The link can be used once and expires in ${minutes(
              auth.tokens.resetTtlSeconds,
            )} minutes.`,
            '',
            'If you did not request this, you can ignore this message — your',
            'password has not changed.',
          ].join('\n'),
        });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      expiresIn: auth.tokens.verificationTtlSeconds,

      /**
       * The user still signs in explicitly after verifying. Auto-signing-in from
       * a link means a forwarded email grants a session.
       */
      autoSignInAfterVerification: false,

      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          subject: 'Verify your email address',
          text: [
            `Welcome${user.name ? `, ${user.name}` : ''}.`,
            '',
            'Confirm your email address by opening this link:',
            url,
            '',
            `The link can be used once and expires in ${minutes(
              auth.tokens.verificationTtlSeconds,
            )} minutes.`,
            '',
            'If you did not create this account, you can ignore this message.',
          ].join('\n'),
        });
      },
    },

    /**
     * Derived from which credential groups are configured, so a provider with no
     * credentials is simply absent rather than present-and-broken.
     */
    socialProviders: auth.socialProviders,

    plugins: [
      twoFactor({
        issuer: auth.totpIssuer,

        /**
         * NOT the default, and the default is the problem: `encodeBackupCodes`
         * falls through to `return json`, so backup codes would sit in the
         * database as plaintext JSON — directly usable by anyone who reads the
         * table. `"encrypted"` encrypts them under `BETTER_AUTH_SECRET`.
         *
         * Verified in `better-auth/dist/plugins/two-factor/backup-codes/index.mjs`.
         */
        storeBackupCodes: 'encrypted',
      }),

      /** Accepts the same session token as `Authorization: Bearer …`. */
      bearer(),
    ],

    /**
     * Per-address limiting for the whole auth surface, tighter on the credential
     * paths. Counters live in Redis (`secondary-storage`, the adapter above) so
     * limits hold across instances rather than per process.
     *
     * Deliberately the library's own limiter rather than `@nestjs/throttler`:
     * application-wide throttling is a later change that will own that
     * dependency, the global guard, and the key scheme, and these routes never
     * reach a Nest guard anyway.
     */
    rateLimit: {
      enabled: true,
      storage: 'secondary-storage',
      window: auth.rateLimit.windowSeconds,
      max: auth.rateLimit.max,
      customRules: Object.fromEntries(
        STRICT_RATE_LIMIT_PATHS.map((path) => [
          path,
          {
            window: auth.rateLimit.strictWindowSeconds,
            max: auth.rateLimit.strictMax,
          },
        ]),
      ),
    },

    hooks: {
      /**
       * Per-account lockout, which the per-address limiter cannot provide.
       *
       * Runs before the credential check so a locked account is refused without
       * the password being verified, and counters are consumed for identifiers
       * that do not exist — otherwise the limiter itself would answer "does this
       * account exist?" that the error messages are careful not to.
       */
      before: createAuthMiddleware(async (ctx) => {
        if (!SIGN_IN_PATHS.includes(ctx.path)) {
          return;
        }

        const identifier = (ctx.body as { email?: unknown } | undefined)?.email;

        if (typeof identifier !== 'string' || identifier === '') {
          return;
        }

        const decision = await lockout.check(identifier);

        if (decision.locked) {
          throw new APIError('TOO_MANY_REQUESTS', {
            code: 'ACCOUNT_LOCKED',
            message:
              'Too many failed sign-in attempts. Try again shortly — no action is needed on your part.',
            retryAfter: decision.retryAfterSeconds,
          });
        }
      }),

      /**
       * Counts the outcome. A failure increments; a success clears the history,
       * so a legitimate user who mistyped a few times starts clean.
       */
      after: createAuthMiddleware(async (ctx) => {
        if (!SIGN_IN_PATHS.includes(ctx.path)) {
          return;
        }

        const identifier = (ctx.body as { email?: unknown } | undefined)?.email;

        if (typeof identifier !== 'string' || identifier === '') {
          return;
        }

        /**
         * The outcome is read by shape rather than with `instanceof APIError`.
         * This module crosses the CommonJS/ESM boundary, so class identity is
         * not something to stake a security control on — and a silently-false
         * `instanceof` here would disable lockout counting altogether while
         * every other test still passed.
         */
        const returned = ctx.context.returned as
          { statusCode?: unknown } | undefined;

        // Compared as plain numbers: `statusCode` comes from the library, not
        // from Nest's HttpStatus enum, so the two share no enum type.
        const status =
          typeof returned?.statusCode === 'number' ? returned.statusCode : 200;

        // Already refused by a limiter: counting it again would let an attacker
        // inflate a victim's backoff for free.
        if (status === 429) {
          return;
        }

        if (status >= 400) {
          await lockout.recordFailure(identifier);
          return;
        }

        await lockout.clear(identifier);
      }),
    },

    advanced: {
      /** Driven by APP_URL's scheme — see the `security` namespace. */
      useSecureCookies: security.servesHttps,

      defaultCookieAttributes: {
        httpOnly: true,
        /**
         * `lax`, not `strict`: `strict` drops the cookie on the return leg of an
         * OAuth redirect, which breaks social sign-in. Not `none` either — that
         * requires `secure` and permits cross-site sends. A fork serving a
         * browser SPA from another registrable domain needs `none`; the README
         * says so and this is the line to change.
         */
        sameSite: 'lax',
        path: '/',
      },

      cookiePrefix: 'app',

      ipAddress: {
        /**
         * One synthetic header, stamped server-side from Express's `req.ip`.
         * The library cannot be told to distrust forwarded headers (it falls
         * back to its defaults for any falsy value), so `TRUST_PROXY` is honoured
         * in Express and the result handed over here. See `client-ip.ts`.
         */
        ipAddressHeaders: [CLIENT_IP_HEADER],
      },
    },
  });
}

/** The configured instance, with `api` fully typed from the options above. */
export type AuthInstance = ReturnType<typeof createAuth>;
