## MODIFIED Requirements

### Requirement: TOTP enrolment requires proof before activation

The system SHALL allow an authenticated user to enrol a time-based one-time password authenticator. Enrolment SHALL return a provisioning secret and an issuer-labelled URI for authenticator apps.

Two-factor authentication MUST NOT become active on the account until the user submits a valid code from the enrolled authenticator, so a user cannot lock themselves out with a misconfigured app. Enrolment MUST require the user's password.

Backup codes SHALL be issued alongside the provisioning secret, at the start of enrolment rather than on confirmation. The user needs them in hand before they commit to a second factor, and an interface that reveals them only after confirmation invites confirming first and recording them later — which is to say, never. Codes issued for an enrolment that is never confirmed MUST confer no access, because they satisfy a pending challenge and no challenge is ever raised while two-factor authentication is inactive.

#### Scenario: Enrolment begins

- **WHEN** an authenticated user starts enrolment and supplies their password
- **THEN** a secret, an issuer-labelled provisioning URI, and a set of backup codes are returned

#### Scenario: Enrolment without the password

- **WHEN** an authenticated user starts enrolment without supplying their password
- **THEN** the request is rejected and no secret is issued

#### Scenario: Enrolment confirmed

- **WHEN** the user submits a valid code generated from the issued secret
- **THEN** two-factor authentication becomes active on the account, and the backup codes issued at enrolment become usable against a pending challenge

#### Scenario: Enrolment never confirmed

- **WHEN** a user requests a secret but never submits a valid code
- **THEN** two-factor authentication remains inactive and sign-in continues to work with the password alone

#### Scenario: Codes from an unconfirmed enrolment confer nothing

- **WHEN** a user holds backup codes from an enrolment they never confirmed
- **THEN** those codes grant no access, because sign-in raises no second-factor challenge for an account where two-factor authentication is inactive

#### Scenario: Invalid code during enrolment

- **WHEN** the user submits an incorrect code while confirming enrolment
- **THEN** enrolment does not activate and the user may retry

### Requirement: Single-use backup codes

Backup codes SHALL be issued at the start of enrolment, and each code SHALL satisfy a pending challenge exactly once once two-factor authentication is active.

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
