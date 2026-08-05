/**
 * Metrics scrape path — outside `/api/v1`, like health probes.
 */
export const METRICS_PATH = '/metrics';

export const METRICS_PATHS: readonly string[] = [METRICS_PATH];

export function isMetricsPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return METRICS_PATHS.includes(path);
}
