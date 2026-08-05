import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * Registers `IdempotencyInterceptor` globally so `@Idempotent()` works on any
 * route without per-controller wiring; it is a no-op on every undecorated
 * route. Must be imported **before** `CommonModule` in `AppModule` so this
 * interceptor wraps `ResponseEnvelopeInterceptor` — a replay returns the
 * exact envelope stored from the first successful run, rather than being
 * re-wrapped.
 */
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
})
export class IdempotencyModule {}
