## MODIFIED Requirements

### Requirement: Signed webhooks grant credits idempotently

The system SHALL expose a webhook endpoint that verifies the Stripe signature against the raw request body and the configured webhook secret. On a successful `checkout.session.completed` (or equivalent paid completion event) for a credit top-up session, the system MUST grant the configured pack's credits via the credit ledger using a canonical idempotency key derived from the Checkout Session (so retries and duplicate events do not double-grant).

Processed Stripe event identifiers MUST be recorded so at-least-once delivery cannot double-apply side effects. Invalid signatures MUST be rejected without granting credits.

Settlement SHALL be tested positively, on the session's payment status, and MUST NOT be inferred from the session having completed. A session's completion and its payment are separate facts: delayed-notification payment methods complete a session while payment is still outstanding, so a condition satisfied by completion alone credits an account before any money has settled. Only a payment status indicating settled or not-required MAY grant.

Because settlement can follow completion, the system SHALL also grant on the event that reports a later successful payment for a session it has already seen. Tightening the settlement test without handling that event would replace over-granting with silent non-delivery — the customer pays and is never credited — which is the worse of the two failures. Both paths MUST derive the same canonical idempotency key from the Checkout Session, so whichever arrives first grants and the other is a no-op.

The events the deployment must subscribe to SHALL be documented, since a grant path that is correct in code still never runs if the endpoint is not subscribed to the event that carries it.

#### Scenario: Valid paid Checkout completion grants once

- **WHEN** a correctly signed paid Checkout completion webhook is received for a top-up session
- **THEN** the user's wallet is credited by the pack amount exactly once

#### Scenario: Completed but unpaid session does not grant

- **WHEN** a correctly signed completion webhook is received for a session whose payment status reports the payment as outstanding
- **THEN** no credits are granted, and the wallet balance is unchanged

#### Scenario: Session requiring no payment grants

- **WHEN** a completion webhook reports that the session required no payment
- **THEN** the pack's credits are granted, because there is no outstanding payment to wait for

#### Scenario: Delayed payment grants when it settles

- **WHEN** a session completed while unpaid and a later correctly signed event reports its payment succeeded
- **THEN** the pack's credits are granted at that point

#### Scenario: Completion and later settlement grant only once in total

- **WHEN** both the completion event and the later payment-succeeded event are processed for the same session
- **THEN** the wallet is credited exactly once in total, because both derive the same canonical idempotency key

#### Scenario: Duplicate event does not double-grant

- **WHEN** the same Stripe event (or the same Checkout Session completion) is delivered again
- **THEN** the wallet balance does not increase a second time and the endpoint acknowledges without error semantics that would cause infinite retry storms

#### Scenario: Invalid signature is rejected

- **WHEN** a webhook request fails signature verification
- **THEN** the response is an error status, no credits are granted, and no processed-event success record is stored for that payload as a successful grant

#### Scenario: Required event subscriptions are documented

- **WHEN** an operator reads the setup documentation
- **THEN** it names every event the webhook must receive for credits to be granted, including the delayed-settlement event
