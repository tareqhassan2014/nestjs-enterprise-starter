import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Any change to a second factor is re-authenticated with the password.
 *
 * A stolen session must not be enough to disable 2FA, re-issue backup codes, or
 * enrol an attacker's authenticator — otherwise the second factor protects only
 * sign-in and not the account.
 */
export class PasswordConfirmationDto {
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class VerifyTotpDto {
  @IsString()
  @IsNotEmpty()
  code!: string;
}
