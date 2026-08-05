## ADDED Requirements

### Requirement: Error codes for idempotency and organization context

The error-code set MUST include `IDEMPOTENCY_KEY_REQUIRED` for annotated POSTs missing an idempotency key, and `IDEMPOTENCY_KEY_REUSE` for key reuse with a different request fingerprint. Existing codes, including `CONFLICT`, `FORBIDDEN`, `INSUFFICIENT_CREDITS`, and `UNAUTHORIZED`, MUST retain their identifiers and meanings.

Organization binding failures that are authorization failures MUST continue to use `FORBIDDEN` (or a documented dedicated code if introduced consistently); they MUST NOT be reported as validation success.

#### Scenario: Missing idempotency key

- **WHEN** an idempotency-annotated POST omits `Idempotency-Key`
- **THEN** the error envelope carries `error.code` `IDEMPOTENCY_KEY_REQUIRED`

#### Scenario: Idempotency key reuse

- **WHEN** a client reuses an idempotency key with a different body fingerprint
- **THEN** the error envelope carries `error.code` `IDEMPOTENCY_KEY_REUSE`
