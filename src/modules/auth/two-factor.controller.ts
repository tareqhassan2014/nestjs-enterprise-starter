import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';

import { StrictThrottle } from '@modules/throttling/throttle.decorators';

import { CurrentUser } from './auth.decorators';
import type { AuthInstance } from './auth.factory';
import type { AuthenticatedPrincipal } from './auth.service';
import { AUTH_INSTANCE } from './auth.tokens';
import { PasswordConfirmationDto, VerifyTotpDto } from './dto/two-factor.dto';

interface TwoFactorStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

/**
 * First-party two-factor endpoints, inside the response envelope.
 *
 * These are ours rather than Better Auth's raw surface for two reasons: the
 * remaining-backup-code count is a question the library does not answer, and
 * status/enrolment belong under `/api/v1` where the client already reads the
 * standard envelope. Enrolment and verification themselves delegate to the
 * plugin — the cryptography is not ours to reimplement.
 */
@StrictThrottle()
@Controller({ path: 'account/two-factor', version: '1' })
export class TwoFactorController {
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: AuthInstance) {}

  /**
   * Whether 2FA is active, and how many backup codes remain — so a user can
   * re-issue before running out rather than discovering it while locked out.
   *
   * The count comes from the library's **server-only** `viewBackupCodes`, which
   * decrypts the blob internally. Only the count crosses the boundary; the codes
   * themselves are never returned or logged. Counting by inspecting the stored
   * ciphertext would be a fabricated number, and reporting a made-up count is
   * worse than reporting none.
   */
  @Get()
  async status(
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<TwoFactorStatus> {
    if (!user.twoFactorEnabled) {
      return { enabled: false, backupCodesRemaining: 0 };
    }

    return {
      enabled: true,
      backupCodesRemaining: await this.countBackupCodes(user.id),
    };
  }

  /**
   * Step one of enrolment: issues the secret and provisioning URI.
   *
   * 2FA does **not** become active here — the user must prove the authenticator
   * works by submitting a code to `verify`. Anything else lets a user lock
   * themselves out with a misconfigured app.
   */
  @Post('enable')
  async enable(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: PasswordConfirmationDto,
  ): Promise<{ totpURI: string; backupCodes: string[] }> {
    const result = await this.forwardingCookies(request, response, (headers) =>
      this.auth.api.enableTwoFactor({
        body: { password: body.password },
        headers,
        returnHeaders: true,
      }),
    );

    return { totpURI: result.totpURI, backupCodes: result.backupCodes };
  }

  /** Step two: proves the authenticator works and activates 2FA. */
  @Post('verify')
  async verify(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: VerifyTotpDto,
  ): Promise<{ verified: boolean }> {
    await this.forwardingCookies(request, response, (headers) =>
      this.auth.api.verifyTOTP({
        body: { code: body.code },
        headers,
        returnHeaders: true,
      }),
    );

    return { verified: true };
  }

  /** Invalidates every previously issued code and returns a fresh set. */
  @Post('backup-codes')
  async regenerateBackupCodes(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: PasswordConfirmationDto,
  ): Promise<{ backupCodes: string[] }> {
    const result = await this.forwardingCookies(request, response, (headers) =>
      this.auth.api.generateBackupCodes({
        body: { password: body.password },
        headers,
        returnHeaders: true,
      }),
    );

    return { backupCodes: result.backupCodes };
  }

  /** Clears the enrolled secret and all backup codes. */
  @Post('disable')
  async disable(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: PasswordConfirmationDto,
  ): Promise<{ enabled: false }> {
    await this.forwardingCookies(request, response, (headers) =>
      this.auth.api.disableTwoFactor({
        body: { password: body.password },
        headers,
        returnHeaders: true,
      }),
    );

    return { enabled: false };
  }

  /**
   * Runs a Better Auth call and copies any cookies it set onto our response.
   *
   * Not optional plumbing. `enableTwoFactor` **deletes the current session and
   * creates a replacement**, handing back a new session cookie; a proxy that
   * drops it signs the user out at the exact moment they turn on 2FA, and the
   * symptom (`401` on the next request) looks nothing like the cause. The same
   * applies to any endpoint that rotates the session.
   *
   * `@Res({ passthrough: true })` keeps Nest in charge of serialising the return
   * value, so the response envelope still applies.
   */
  private async forwardingCookies<T>(
    request: Request,
    response: Response,
    call: (headers: Headers) => Promise<{ headers: Headers; response: T }>,
  ): Promise<T> {
    const result = await call(fromNodeHeaders(request.headers));

    for (const cookie of result.headers.getSetCookie()) {
      response.append('set-cookie', cookie);
    }

    return result.response;
  }

  /**
   * Counts unused backup codes without letting them escape.
   *
   * A user with 2FA active but no backup-code record makes the library throw
   * rather than return zero, so that is treated as "none remaining".
   */
  private async countBackupCodes(userId: string): Promise<number> {
    try {
      const result = await this.auth.api.viewBackupCodes({ body: { userId } });

      return result.backupCodes.length;
    } catch {
      return 0;
    }
  }
}
