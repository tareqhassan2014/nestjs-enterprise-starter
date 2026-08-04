# Structured Logging

## Purpose

Machine-readable logs carrying per-request correlation, with sensitive values redacted centrally rather than at the discretion of each call site.

Structured output on stdout is the contract; collection and shipping are the operator's concern.

## Requirements

### Requirement: Structured logging as the application logger

The application SHALL emit structured logs through a single logger, registered as the framework logger so that framework and application logs share one stream and one format.

Logs emitted during bootstrap, before the logger is available, MUST be buffered and flushed through it rather than written in a different format.

#### Scenario: Framework log during bootstrap

- **WHEN** the framework logs module initialization at startup
- **THEN** the entry is emitted in the configured structured format, not the framework's default format

#### Scenario: Application log from a provider

- **WHEN** a provider logs an informational message
- **THEN** the entry carries the configured level, a timestamp, and the provider's context name

### Requirement: Environment-appropriate output format

Log output SHALL be newline-delimited JSON by default, and human-readable pretty-printed output in development. The pretty-printing dependency MUST NOT be required at runtime in production.

Pretty output is limited to development rather than all non-production environments: the pretty transport runs in a worker thread, which leaks open handles across a test run.

Where the pretty-printing dependency is unavailable, the logger SHALL fall back to JSON rather than failing to start — a misconfigured environment must not turn log formatting into a boot failure.

The minimum log level SHALL come from validated configuration.

#### Scenario: Production formatting

- **WHEN** the application runs with `NODE_ENV=production`
- **THEN** each log entry is a single line of valid JSON

#### Scenario: Development formatting

- **WHEN** the application runs with `NODE_ENV=development`
- **THEN** log entries are pretty-printed for terminal reading

#### Scenario: Test formatting

- **WHEN** the application runs with `NODE_ENV=test`
- **THEN** output is JSON, so no worker-thread transport is started

#### Scenario: Pretty-printing dependency absent

- **WHEN** the configuration asks for pretty output but the pretty-printing dependency cannot be resolved, as in the production image
- **THEN** the application starts and emits JSON instead of failing to boot

#### Scenario: Level threshold applied

- **WHEN** the configured level is `warn`
- **THEN** `debug` and `info` entries are not emitted and `warn` and `error` entries are

### Requirement: Automatic request logging with correlation

Completed HTTP requests SHALL be logged automatically with method, path, status code, and duration. Every log line emitted during a request SHALL carry that request's correlation identifier.

Health-check routes SHALL be excluded from automatic request logging so probe traffic does not dominate log volume.

#### Scenario: Request completes successfully

- **WHEN** a request completes with `200`
- **THEN** one entry records the method, path, status, and duration, and carries the request's correlation ID

#### Scenario: Log emitted deep in the call stack

- **WHEN** a service several layers below the controller logs a message during a request
- **THEN** that entry carries the same correlation ID as the request's completion entry

#### Scenario: Readiness probe

- **WHEN** an orchestrator polls the readiness endpoint
- **THEN** no automatic request-completion log entry is emitted for it

### Requirement: Redaction of sensitive fields

The logger SHALL redact sensitive values before serialization, covering at minimum the `authorization` header, request and response cookie headers, and any field named `password`, `token`, `secret`, `apiKey`, or `accessToken` appearing at the top level or nested within the log payload.

Redaction MUST be configured centrally; it MUST NOT depend on individual call sites remembering to omit values.

Nesting depth is bounded by the redaction paths declared in configuration — the underlying engine has no unbounded-depth wildcard — and the declared paths MUST cover at least three levels. Deeper coverage is added by extending that configuration, never by redacting at a call site.

#### Scenario: Request carries a bearer token

- **WHEN** a request arrives with an `authorization: Bearer <token>` header and its completion is logged
- **THEN** the serialized entry does not contain the token value

#### Scenario: Object containing a password is logged

- **WHEN** a provider logs an object with a `password` property
- **THEN** the serialized entry shows the property as redacted and not its value

#### Scenario: Cookies present

- **WHEN** a request carries a `cookie` header and the response sets `set-cookie`
- **THEN** neither header's value appears in the serialized log entry
