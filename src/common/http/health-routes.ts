/**
 * Health routes, in one place because three separate mechanisms consume them:
 * the global prefix exclusion, the logger's auto-logging ignore list, and the
 * exception filter's raw-payload carve-out.
 *
 * They sit outside `/api/v1` so an orchestrator's probe configuration survives
 * a future API version bump.
 */
export const HEALTH_LIVENESS_PATH = '/health/live';
export const HEALTH_READINESS_PATH = '/health/ready';

export const HEALTH_PATHS: readonly string[] = [
  HEALTH_LIVENESS_PATH,
  HEALTH_READINESS_PATH,
];

export function isHealthPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return HEALTH_PATHS.includes(path);
}

/**
 * The request's path as the client sent it.
 *
 * Express rewrites `req.url` to be relative to a middleware's mount point, so
 * inside mounted middleware `/health/live` arrives as `/`. `originalUrl` is the
 * only reliable source there — reading `req.url` silently matches nothing.
 */
export function requestPath(req: {
  originalUrl?: string;
  url?: string;
}): string | undefined {
  return req.originalUrl ?? req.url;
}
