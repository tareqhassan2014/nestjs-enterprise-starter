/**
 * MCP transport path — outside `/api/v1`, like health and metrics.
 */
export const DEFAULT_MCP_PATH = '/mcp';

export function normalizeMcpPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) {
    return `/${trimmed}`;
  }
  return trimmed.replace(/\/+$/, '') || '/';
}

export function isMcpPath(
  url: string | undefined,
  configuredPath: string = DEFAULT_MCP_PATH,
): boolean {
  const path = (url ?? '').split('?')[0];
  const expected = normalizeMcpPath(configuredPath);
  return path === expected || path.startsWith(`${expected}/`);
}
