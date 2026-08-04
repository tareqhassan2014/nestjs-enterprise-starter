import { SetMetadata } from '@nestjs/common';

export const NO_ENVELOPE_KEY = 'noEnvelope';

/**
 * Exempts a handler from the success envelope, for consumers that require a
 * specific response shape — orchestrator health probes today, file downloads
 * or third-party callbacks later.
 *
 * Errors thrown from an exempt handler still go through the error envelope.
 * The health endpoints are the one exception to that, since probes need the
 * Terminus payload on failure too; see AllExceptionsFilter.
 */
export const NoEnvelope = () => SetMetadata(NO_ENVELOPE_KEY, true);
