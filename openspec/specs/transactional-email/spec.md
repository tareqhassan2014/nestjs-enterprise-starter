# Transactional Email

## Purpose

Outbound mail behind a provider-agnostic port: application code describes a message, an adapter delivers it, and replacing the provider means one adapter and one configuration value.

A development adapter records messages instead of delivering them, so tests can read a verification link with no SMTP server running. That adapter cannot be selected in production: a transport that silently discards mail would make every registration appear to succeed while leaving the accounts unreachable, so boot fails instead. Dispatch failures surface rather than disappear.

## Requirements

### Requirement: Outbound mail is consumed through a provider-agnostic port

Application code SHALL send mail only through a single injectable port that describes a message, never by calling a mail provider's client directly.

The port MUST NOT expose provider-specific concepts, so replacing the provider requires implementing one adapter and changing one configuration value, with no edit to calling code.

#### Scenario: Auth flow sends a message

- **WHEN** a verification or password reset message is dispatched
- **THEN** it is sent through the port, and the calling code names no provider

#### Scenario: Provider replaced

- **WHEN** a fork implements a new adapter for a different provider and selects it in configuration
- **THEN** no authentication code changes

#### Scenario: Port surface is provider-neutral

- **WHEN** the port's interface is inspected
- **THEN** it describes recipient, subject, and body, and exposes no provider-specific option

### Requirement: Transport is selected by configuration, with two adapters supplied

The system SHALL supply a development adapter that records messages without delivering them, and an SMTP adapter that delivers them.

The transport SHALL be chosen by a validated configuration value. When the SMTP transport is selected, its connection settings MUST be required as a group, and a partially configured group MUST fail validation at boot.

#### Scenario: Development transport selected

- **WHEN** the development transport is configured and a message is dispatched
- **THEN** the message is recorded and no network delivery is attempted

#### Scenario: SMTP transport selected

- **WHEN** the SMTP transport is configured with a complete connection group and a message is dispatched
- **THEN** the message is handed to the SMTP server

#### Scenario: SMTP half-configured

- **WHEN** the SMTP transport is selected with the host present but credentials missing
- **THEN** validation fails at boot naming the missing variables

#### Scenario: Unknown transport

- **WHEN** the transport value is not one of the supported transports
- **THEN** validation fails and names the accepted values

### Requirement: The non-delivering transport cannot be selected in production

Selecting the development transport while running in the production environment SHALL fail validation at boot.

A transport that silently discards mail would make registration appear to succeed while every verification and reset message vanished, leaving unreachable accounts. Failing at boot is required instead.

#### Scenario: Development transport in production

- **WHEN** the application starts in the production environment with the development transport configured
- **THEN** validation fails, the error explains that a delivering transport is required, and no port is bound

#### Scenario: Development transport outside production

- **WHEN** the application starts in development or test with the development transport configured
- **THEN** validation passes and messages are recorded rather than delivered

### Requirement: Recorded messages are assertable by tests

The development adapter SHALL retain recently recorded messages in memory so end-to-end tests can assert on their content without an SMTP server.

Retention MUST be bounded so a long-running process cannot grow without limit. Tests MUST be able to read the delivered link from a recorded message.

#### Scenario: Test reads a verification link

- **WHEN** an end-to-end test registers a user and inspects the recorded messages
- **THEN** it finds the verification message and can extract the verification link from it

#### Scenario: Retention is bounded

- **WHEN** more messages are recorded than the retention limit
- **THEN** the oldest are discarded and memory use stays bounded

#### Scenario: No SMTP server required

- **WHEN** the test suite runs with no SMTP server available
- **THEN** every mail-dependent test passes

### Requirement: Delivery failures surface rather than disappear

A failure to dispatch a message SHALL be logged at error level with the request identifier and SHALL propagate to the caller as a failed request.

A delivery failure MUST NOT be swallowed, and MUST NOT be reported to the client as success. Where a failure leaves an account created but unverified, a resend path MUST exist so the state is recoverable.

#### Scenario: Transport rejects the message

- **WHEN** the configured transport fails while sending a verification message
- **THEN** the failure is logged at error level with the request identifier and the request does not report success

#### Scenario: Failure is recoverable

- **WHEN** a registration succeeded but its verification message failed to send
- **THEN** the user can request the verification message again and complete verification

#### Scenario: No silent success

- **WHEN** a dispatch fails
- **THEN** no response claims the message was sent

### Requirement: Message contents and transport credentials are not logged

Log output SHALL NOT contain SMTP credentials, and SHALL NOT contain the security-sensitive contents of a message body such as verification or reset tokens.

The development adapter MAY record full contents in memory for tests, but MUST NOT write tokens to the log stream.

#### Scenario: Send is logged

- **WHEN** a message dispatch is logged
- **THEN** the entry records recipient and subject, and contains no verification or reset token

#### Scenario: SMTP credentials never logged

- **WHEN** the SMTP transport is configured and any log entry is emitted
- **THEN** no entry contains the SMTP password

#### Scenario: Development adapter retains but does not log tokens

- **WHEN** the development adapter records a message containing a reset token
- **THEN** the token is readable from the in-memory record and absent from the log stream
