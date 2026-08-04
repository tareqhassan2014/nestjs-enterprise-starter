import type { Request } from 'express';

/**
 * The one header Better Auth is configured to read a client address from.
 *
 * Set server-side on every request from Express's own `req.ip`, and
 * **unconditionally overwritten**, so a client cannot forge it. That matters
 * because every IP-keyed decision — rate limits, lockout buckets — is only as
 * trustworthy as this value.
 *
 * Why a synthetic header rather than configuring the real ones: Better Auth
 * resolves the address with
 *
 *     options.advanced?.ipAddress?.ipAddressHeaders || DEFAULT_IP_HEADERS
 *
 * (verified in `@better-auth/core/dist/utils/ip.mjs`). Because that is `||` and
 * not `??`, passing an empty array is falsy and silently restores the defaults —
 * which include `x-forwarded-for`. There is therefore no way to ask the library
 * *not* to trust forwarded headers. It also never falls back to the socket
 * address: no header match means no address at all.
 *
 * Routing both cases through Express instead gives one answer to "who is the
 * client", governed by `TRUST_PROXY`:
 *
 * - `TRUST_PROXY=false` → Express ignores `X-Forwarded-For`, so `req.ip` is the
 *   socket peer. A forged header changes nothing.
 * - `TRUST_PROXY=true`  → Express parses `X-Forwarded-For` per its own trust
 *   settings and `req.ip` is the real client.
 */
export const CLIENT_IP_HEADER = 'x-real-client-ip';

/**
 * Stamps the resolved client address onto the request, replacing anything the
 * client sent under that name.
 */
export function stampClientIp(request: Request): void {
  const resolved = request.ip ?? request.socket.remoteAddress;

  if (resolved === undefined) {
    delete request.headers[CLIENT_IP_HEADER];
    return;
  }

  request.headers[CLIENT_IP_HEADER] = resolved;
}
