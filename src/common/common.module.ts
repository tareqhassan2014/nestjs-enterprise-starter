import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { AllExceptionsFilter } from '@common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from '@common/interceptors/response-envelope.interceptor';
import { buildValidationPipe } from '@common/pipes/validation-pipe.factory';

/**
 * The request contract — validation in, envelope out, errors filtered.
 *
 * Registered as providers rather than via `app.useGlobal*` so the same wiring
 * applies in tests that build the app through `Test.createTestingModule`,
 * rather than only on the path `main.ts` happens to take.
 */
@Module({
  providers: [
    { provide: APP_PIPE, useFactory: buildValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class CommonModule {}
