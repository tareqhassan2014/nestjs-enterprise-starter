## ADDED Requirements

### Requirement: Error codes for throttling and usage limits

The error code set SHALL include `USAGE_LIMIT_EXCEEDED` for daily/weekly quota exhaustion, distinct from `RATE_LIMITED` used for burst and per-minute request throttling.

Existing codes, including `RATE_LIMITED`, MUST retain their identifiers and meanings. Clients MUST be able to branch on `code` to choose between a short retry and a period-reset / upgrade path.

#### Scenario: Nest throttle rejection code

- **WHEN** a Nest route rejects a request for exceeding a burst or per-minute throttle
- **THEN** the error envelope carries `error.code` `RATE_LIMITED`

#### Scenario: Usage ceiling rejection code

- **WHEN** a request is rejected because a daily or weekly usage ceiling is exhausted
- **THEN** the error envelope carries `error.code` `USAGE_LIMIT_EXCEEDED`

#### Scenario: Existing codes unchanged

- **WHEN** the error code set is inspected after this change
- **THEN** every code that existed before this change retains its identifier and meaning

### Requirement: Retry and reset metadata on limit responses

Limit rejections on enveloped Nest routes SHALL expose machine-readable timing: a `Retry-After` response header with whole seconds until retry is appropriate, and optional structured `error.details` describing which limit applied.

#### Scenario: Throttle Retry-After

- **WHEN** a Nest throttle limit is exceeded
- **THEN** the response includes `Retry-After` and `error.code` `RATE_LIMITED`

#### Scenario: Usage Retry-After and details

- **WHEN** a usage ceiling is exceeded
- **THEN** the response includes `Retry-After`
- **AND** `error.details` includes the feature identifier and the period (`day` or `week`) that was exhausted
