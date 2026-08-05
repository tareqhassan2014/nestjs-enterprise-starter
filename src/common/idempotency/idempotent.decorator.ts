import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotency:required';

/**
 * Requires clients to send `Idempotency-Key` on this route and replays the
 * stored response for a retry with the same key + request body, rather than
 * re-running the handler. See `IdempotencyInterceptor`.
 *
 * Opt-in by design — most routes have no double-submission risk worth the
 * storage cost. Apply it to the starter's documented critical POSTs
 * (organization create, admin credit adjust, Stripe checkout session create)
 * and to any fork-added route where a client retry must not double-apply.
 */
export const Idempotent = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IDEMPOTENT_KEY, true);
