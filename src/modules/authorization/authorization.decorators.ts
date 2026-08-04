import { SetMetadata } from '@nestjs/common';

import type { Permission, RoleName } from './permissions';

export const REQUIRED_PERMISSIONS_KEY = 'authz:permissions';
export const REQUIRED_ROLES_KEY = 'authz:roles';

/**
 * Requires **every** listed permission.
 *
 * Typed against the declared catalogue, so `@RequirePermissions('user:raed')`
 * fails the type check rather than becoming a condition that silently never
 * passes. That is the whole reason the vocabulary lives in code while the
 * assignments live in the database.
 */
export const RequirePermissions = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Requires **any one** of the listed roles.
 *
 * Prefer `@RequirePermissions` — a permission says what the route needs, while a
 * role says who is currently allowed to do it, and only the former survives a
 * reorganisation of the roles. This exists for the cases where the role really
 * is the requirement.
 */
export const RequireRoles = (
  ...roles: [RoleName, ...RoleName[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_ROLES_KEY, roles);
