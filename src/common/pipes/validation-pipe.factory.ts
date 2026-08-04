import { HttpStatus, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

export interface ValidationDetail {
  field: string;
  constraint: string;
  message: string;
}

/**
 * Flattens class-validator's nested error tree into a machine-readable list,
 * with dotted paths for nested fields (`address.postalCode`), so clients can
 * map failures onto form fields without parsing prose.
 */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): ValidationDetail[] {
  const details: ValidationDetail[] = [];

  for (const error of errors) {
    const field = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;

    for (const [constraint, message] of Object.entries(
      error.constraints ?? {},
    )) {
      details.push({ field, constraint, message });
    }

    if (error.children && error.children.length > 0) {
      details.push(...flattenValidationErrors(error.children, field));
    }
  }

  return details;
}

/**
 * Strict by default, deliberately:
 *
 * - `forbidNonWhitelisted` turns a misspelled field into a 400 instead of a
 *   silent no-op. For a billing-adjacent API, silence is the worse failure.
 * - `enableImplicitConversion` coerces path and query params to their declared
 *   types. It converts but does not reject, so every query/param DTO must carry
 *   explicit class-validator decorators — those are what actually validate.
 *
 * Routes that must accept payloads we do not model (third-party webhooks) take
 * a raw body and bypass this pipe at the route level; see README.
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors: ValidationError[]) =>
      new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed.',
        flattenValidationErrors(errors),
      ),
  });
}
