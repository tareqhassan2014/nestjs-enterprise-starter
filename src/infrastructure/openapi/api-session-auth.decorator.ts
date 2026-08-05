import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth } from '@nestjs/swagger';

import {
  OPENAPI_SESSION_BEARER,
  OPENAPI_SESSION_COOKIE,
} from './openapi.document';

/**
 * Documents that a Nest controller accepts Better Auth session credentials
 * via cookie and/or Authorization Bearer (session token — not an API key).
 */
export function ApiSessionAuth() {
  return applyDecorators(
    ApiCookieAuth(OPENAPI_SESSION_COOKIE),
    ApiBearerAuth(OPENAPI_SESSION_BEARER),
  );
}
