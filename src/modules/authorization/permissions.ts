/**
 * The permission vocabulary. Code owns this list; the database owns who has what.
 *
 * Declared here rather than read from the database so that `@RequirePermissions`
 * is typed against it: naming a permission that does not exist is a compile
 * error, not a check that silently never passes. The seed upserts these into the
 * `Permission` table, and a row present there but absent here is inert, because
 * no annotation can reference it.
 *
 * Adding one: append it here, give it to a role in `BASELINE_ROLES`, and re-run
 * `pnpm db:seed`. Removing one: delete it here and from the roles, then re-seed —
 * the orphaned row stops mattering the moment nothing names it.
 *
 * Naming is `resource:action`. Keep it flat: these are coarse capability checks,
 * not row-level rules. A decision that depends on a specific record belongs in
 * the service that already loaded it.
 */
export const PERMISSIONS = [
  // A caller's own account.
  'account:read',
  'account:update',
  'account:delete',

  // Other users, for support and administration.
  'user:read',
  'user:list',
  'user:update',
  'user:delete',

  // Roles and their permission mappings.
  'role:read',
  'role:assign',
  'role:manage',

  // Operational / admin monitoring surfaces.
  'admin:metrics:read',
  'admin:audit:read',
  'admin:subscriptions:read',
  'admin:credits:read',
  'admin:credits:adjust',

  // Agent API keys (session-managed) and MCP tool surface.
  'api-keys:manage',
  'mcp:tools:invoke',
] as const;

/** Every valid permission key. Annotations are typed against this. */
export type Permission = (typeof PERMISSIONS)[number];

/** Human-readable purpose per permission, used as the seeded description. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'account:read': 'Read your own profile and session list',
  'account:update': 'Update your own profile and credentials',
  'account:delete': 'Delete your own account',
  'user:read': "Read another user's profile",
  'user:list': 'List users',
  'user:update': "Update another user's profile",
  'user:delete': 'Delete another user',
  'role:read': 'Read roles and their permissions',
  'role:assign': 'Grant and revoke roles for a user',
  'role:manage': 'Create, edit, and delete roles and their permission mappings',
  'admin:metrics:read': 'Read operational metrics and usage dashboards',
  'admin:audit:read': 'Read admin audit records',
  'admin:subscriptions:read':
    "Read another user's subscription and effective plan",
  'admin:credits:read': "Read another user's credit wallet and ledger",
  'admin:credits:adjust': 'Grant or adjust credits for another user',
  'api-keys:manage': 'Create, list, and revoke your own agent API keys',
  'mcp:tools:invoke': 'Invoke MCP tools as an authenticated agent',
};

/** Role names the seed guarantees exist. */
export const ROLE_NAMES = {
  admin: 'admin',
  user: 'user',
} as const;

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES];

/**
 * Baseline roles and their grants.
 *
 * `user` is what a newly registered account gets: authority over itself and
 * nothing else. `admin` holds everything, which is stated as "all of
 * `PERMISSIONS`" rather than a copied list so a new permission cannot be
 * accidentally withheld from administrators.
 *
 * These are starting points, not fixtures — an operator may edit the mappings at
 * runtime, and re-seeding will not undo grants beyond re-asserting the baseline.
 */
export const BASELINE_ROLES: Record<
  RoleName,
  { description: string; permissions: readonly Permission[] }
> = {
  [ROLE_NAMES.user]: {
    description: 'A registered end user, with authority over their own account',
    permissions: [
      'account:read',
      'account:update',
      'account:delete',
      'api-keys:manage',
      'mcp:tools:invoke',
    ],
  },
  [ROLE_NAMES.admin]: {
    description: 'Full administrative access',
    permissions: PERMISSIONS,
  },
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
