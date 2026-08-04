# Two-Factor Authentication

## Purpose

An optional second factor: time-based one-time codes with single-use backup codes, activated only once the user has proved their authenticator works.

A correct password yields a pending challenge rather than a session, so the second factor gates access instead of decorating it. Enrolling, re-issuing backup codes, and disabling all require the password, because each changes who can get in. No secret, code, or provisioning URI reaches the log stream.

## Requirements

### Requirement: TOTP enrolment requires proof before activation

The system SHALL allow an authenticated user to enrol a time-based one-time password authenticator. Enrolment SHALL return a provisioning secret and an issuer-labelled URI for authenticator apps.

Two-factor authentication MUST NOT become active on the account until the user submits a valid code from the enrolled authenticator, so a user cannot lock themselves out with a misconfigured app. Enrolment MUST require the user's password.

#### Scenario: Enrolment begins

- **WHEN** an authenticated user starts enrolment and supplies their password
- **THEN** a secret and an issuer-labelled provisioning URI are returned

#### Scenario: Enrolment without the password

- **WHEN** an authenticated user starts enrolment without supplying their password
- **THEN** the request is rejected and no secret is issued

#### Scenario: Enrolment confirmed

- **WHEN** the user submits a valid code generated from the issued secret
- **THEN** two-factor authentication becomes active on the account and backup codes are issued

#### Scenario: Enrolment never confirmed

- **WHEN** a user requests a secret but never submits a valid code
- **THEN** two-factor authentication remains inactive and sign-in continues to work with the password alone

#### Scenario: Invalid code during enrolment

- **WHEN** the user submits an incorrect code while confirming enrolment
- **THEN** enrolment does not activate and the user may retry

### Requirement: A correct password yields a challenge, not a session, when 2FA is active

When two-factor authentication is active for an account, a successful password verification SHALL produce a pending two-factor challenge rather than an authenticated session.

No session that authenticates ordinary requests MUST be issued until the second factor is satisfied. The pending challenge MUST expire.

#### Scenario: Password correct, second factor outstanding

- **WHEN** a user with active two-factor authentication signs in with the correct password
- **THEN** the response indicates a second factor is required and no usable session is established

#### Scenario: Pending challenge cannot access resources

- **WHEN** a client holding only a pending two-factor challenge calls a protected route
- **THEN** the request is rejected as unauthenticated

#### Scenario: Second factor satisfied

- **WHEN** the user submits a valid time-based code for the pending challenge
- **THEN** a session is established and protected routes become accessible

#### Scenario: Challenge expires

- **WHEN** the pending challenge is not satisfied within its lifetime
- **THEN** it can no longer be completed and the user must sign in again

#### Scenario: Wrong password with 2FA active

- **WHEN** a user with active two-factor authentication signs in with an incorrect password
- **THEN** no challenge is created and the response does not reveal that two-factor authentication is active on the account

### Requirement: Single-use backup codes

Backup codes SHALL be issued when two-factor authentication is activated, and each code SHALL satisfy a pending challenge exactly once.

Backup codes MUST be stored such that the stored form is not directly usable as a code. A consumed code MUST be rejected on reuse. The remaining count SHALL be readable by the user so they can re-issue before exhausting them.

#### Scenario: Backup code satisfies a challenge

- **WHEN** a user with a pending challenge submits an unused backup code
- **THEN** a session is established

#### Scenario: Backup code reused

- **WHEN** the same backup code is submitted a second time
- **THEN** the request is rejected and no session is established

#### Scenario: Stored form is not the code

- **WHEN** the persisted two-factor record is inspected
- **THEN** the backup codes are not readable as plaintext usable codes

#### Scenario: Remaining codes visible

- **WHEN** an authenticated user with active two-factor authentication reads their two-factor status
- **THEN** the number of unused backup codes is reported

#### Scenario: Codes exhausted

- **WHEN** every backup code has been consumed and the user submits another
- **THEN** the request is rejected

### Requirement: Re-issuing backup codes invalidates the previous set

An authenticated user SHALL be able to generate a fresh set of backup codes without re-enrolling their authenticator. Re-issuing SHALL require the user's password, and MUST invalidate every previously issued code.

#### Scenario: Fresh set issued

- **WHEN** an authenticated user re-issues backup codes with a correct password
- **THEN** a new set is returned

#### Scenario: Old codes no longer work

- **WHEN** a code from the previous set is submitted after re-issuing
- **THEN** it is rejected

#### Scenario: Re-issue without the password

- **WHEN** re-issuing is attempted without supplying the password
- **THEN** the request is rejected and the existing codes remain valid

### Requirement: Disabling two-factor authentication requires the password

An authenticated user SHALL be able to disable two-factor authentication by supplying their password. Disabling MUST remove the enrolled secret and invalidate all backup codes.

#### Scenario: Disabled with the password

- **WHEN** an authenticated user disables two-factor authentication with a correct password
- **THEN** it becomes inactive and subsequent sign-in requires only the password

#### Scenario: Disabling without the password

- **WHEN** disabling is attempted without a correct password
- **THEN** the request is rejected and two-factor authentication remains active

#### Scenario: Secrets and codes are cleared

- **WHEN** two-factor authentication is disabled
- **THEN** the enrolled secret and every backup code are invalidated, so re-enabling requires a fresh enrolment

### Requirement: Two-factor secrets and codes are never logged

Time-based codes, provisioning secrets, provisioning URIs, and backup codes SHALL be excluded from log output.

#### Scenario: Enrolment is logged

- **WHEN** an enrolment request completes and its handling is logged
- **THEN** no log entry contains the provisioning secret, the provisioning URI, or any backup code

#### Scenario: Challenge attempt is logged

- **WHEN** a two-factor verification attempt is logged
- **THEN** the submitted code does not appear in the serialized entry
