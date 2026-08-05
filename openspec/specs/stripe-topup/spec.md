# Stripe Top-up

## Purpose

One-time Stripe Checkout credit pack purchases with signed webhooks that grant credits idempotently — without replacing application subscription lifecycle.

## Requirements

### Requirement: Stripe Checkout creates credit top-up sessions

When Stripe top-up is configured, the system SHALL allow an authenticated user to create a Stripe Checkout Session in `payment` mode for a server-defined credit pack. The session MUST associate the Nest user (via Stripe Customer linkage and/or session metadata) and MUST NOT trust a client-supplied credit quantity as the sole source of the eventual grant amount.

Pack definitions (credits per pack and Stripe Price identifiers) MUST come from validated application configuration.

#### Scenario: Authenticated checkout session create

- **WHEN** an authenticated user requests a top-up Checkout for a configured pack while Stripe is enabled
- **THEN** the success envelope returns a Checkout URL (or session client secret / URL fields as implemented) for that pack

#### Scenario: Unauthenticated checkout is rejected

- **WHEN** an unauthenticated client requests Checkout creation
- **THEN** the response is `401`

#### Scenario: Unknown pack is rejected

- **WHEN** an authenticated user requests a pack that is not in configuration
- **THEN** the request fails with a client error and no Checkout Session is created

#### Scenario: Stripe disabled fails closed

- **WHEN** Stripe credentials are not configured and a client requests Checkout creation
- **THEN** the response is `503` with error code `SERVICE_UNAVAILABLE` (or the route is unavailable) and no Stripe API call is required

### Requirement: Stripe Customer is linked to the user

The system SHALL persist a mapping from application user id to Stripe Customer id. Creating a Checkout Session MUST reuse an existing mapping when present, or create and store a Customer when absent.

#### Scenario: First checkout creates and stores a Customer

- **WHEN** a user with no stored Stripe Customer starts Checkout
- **THEN** a Stripe Customer is created and the mapping is persisted before or as part of session creation

#### Scenario: Later checkout reuses the Customer

- **WHEN** the same user starts Checkout again
- **THEN** the existing Stripe Customer id is reused rather than creating a duplicate mapping

### Requirement: Signed webhooks grant credits idempotently

The system SHALL expose a webhook endpoint that verifies the Stripe signature against the raw request body and the configured webhook secret. On a successful `checkout.session.completed` (or equivalent paid completion event) for a credit top-up session, the system MUST grant the configured pack's credits via the credit ledger using a canonical idempotency key derived from the Checkout Session (so retries and duplicate events do not double-grant).

Processed Stripe event identifiers MUST be recorded so at-least-once delivery cannot double-apply side effects. Invalid signatures MUST be rejected without granting credits.

#### Scenario: Valid paid Checkout completion grants once

- **WHEN** a correctly signed paid Checkout completion webhook is received for a top-up session
- **THEN** the user's wallet is credited by the pack amount exactly once

#### Scenario: Duplicate event does not double-grant

- **WHEN** the same Stripe event (or the same Checkout Session completion) is delivered again
- **THEN** the wallet balance does not increase a second time and the endpoint acknowledges without error semantics that would cause infinite retry storms

#### Scenario: Invalid signature is rejected

- **WHEN** a webhook request fails signature verification
- **THEN** the response is an error status, no credits are granted, and no processed-event success record is stored for that payload as a successful grant

### Requirement: Webhook transport is outside the success envelope

The Stripe webhook endpoint SHALL verify and acknowledge using Stripe's expected HTTP semantics and MUST NOT be required to wrap successes in the application's `{ success, data, meta }` envelope. This boundary MUST be documented for operators and clients.

#### Scenario: Webhook acknowledgement shape

- **WHEN** a valid webhook is processed
- **THEN** the response acknowledges receipt without requiring the standard success envelope wrapper

#### Scenario: Boundary is documented

- **WHEN** the API documentation is read
- **THEN** it states that the Stripe webhook path is outside the enveloped application contract

### Requirement: Top-up does not replace plan subscription lifecycle

Stripe top-up in this capability MUST grant credits only. It MUST NOT be the mechanism that creates, cancels, or marks `past_due` on application subscription rows.

#### Scenario: Successful top-up leaves subscription resolution unchanged

- **WHEN** a user completes a credit pack Checkout
- **THEN** their effective plan continues to resolve through the existing subscriptions/plans rules, not through the Checkout Session
