import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '@infrastructure/prisma/prisma.service';
import {
  BASELINE_ROLES,
  PERMISSIONS,
  ROLE_NAMES,
} from '@modules/authorization/permissions';

import { createTestApp } from './create-test-app';

/**
 * Integration test: requires the Compose stack with migrations applied *and the
 * seed run* (`pnpm db:seed`), since these assert on the seeded baseline.
 */
describe('Access-control schema and seed (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('catalogue matches the code declaration', () => {
    it('persists exactly the declared permission keys', async () => {
      const rows = await prisma.permission.findMany({
        select: { key: true },
        orderBy: { key: 'asc' },
      });

      expect(rows.map((row) => row.key)).toEqual([...PERMISSIONS].sort());
    });

    it('holds no duplicate permission key', async () => {
      const rows = await prisma.permission.findMany({ select: { key: true } });

      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    });
  });

  describe('baseline roles', () => {
    it('creates every baseline role', async () => {
      const roles = await prisma.role.findMany({ select: { name: true } });
      const names = roles.map((role) => role.name);

      for (const expected of Object.keys(BASELINE_ROLES)) {
        expect(names).toContain(expected);
      }
    });

    it('grants an administrator every declared permission', async () => {
      const admin = await prisma.role.findUniqueOrThrow({
        where: { name: ROLE_NAMES.admin },
        include: { permissions: { include: { permission: true } } },
      });

      const granted = admin.permissions
        .map((mapping) => mapping.permission.key)
        .sort();

      expect(granted).toEqual([...PERMISSIONS].sort());
    });

    it('limits the end-user role to its own account', async () => {
      const role = await prisma.role.findUniqueOrThrow({
        where: { name: ROLE_NAMES.user },
        include: { permissions: { include: { permission: true } } },
      });

      const granted = role.permissions
        .map((mapping) => mapping.permission.key)
        .sort();

      expect(granted).toEqual([
        'account:delete',
        'account:read',
        'account:update',
      ]);
      expect(granted).not.toContain('user:list');
    });

    it('holds no duplicate role-to-permission mapping', async () => {
      const mappings = await prisma.rolePermission.findMany({
        select: { roleId: true, permissionId: true },
      });

      const pairs = mappings.map(
        (mapping) => `${mapping.roleId}:${mapping.permissionId}`,
      );

      expect(new Set(pairs).size).toBe(pairs.length);
    });
  });

  describe('the database enforces idempotency, not the seed script', () => {
    it('rejects a duplicate role-to-permission mapping', async () => {
      const existing = await prisma.rolePermission.findFirstOrThrow();

      await expect(
        prisma.rolePermission.create({
          data: {
            roleId: existing.roleId,
            permissionId: existing.permissionId,
          },
        }),
      ).rejects.toMatchObject({
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
      });
    });

    it('rejects a duplicate user-to-role assignment', async () => {
      const role = await prisma.role.findUniqueOrThrow({
        where: { name: ROLE_NAMES.user },
      });

      const user = await prisma.user.create({
        data: {
          email: `dup-assign-${Date.now()}@example.test`,
          name: 'Duplicate Assignment',
        },
      });

      try {
        await prisma.userRole.create({
          data: { userId: user.id, roleId: role.id },
        });

        await expect(
          prisma.userRole.create({
            data: { userId: user.id, roleId: role.id },
          }),
        ).rejects.toMatchObject({
          name: 'PrismaClientKnownRequestError',
          code: 'P2002',
        });
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
      }
    });

    it('cascades assignments away when a user is deleted', async () => {
      const role = await prisma.role.findUniqueOrThrow({
        where: { name: ROLE_NAMES.user },
      });

      const user = await prisma.user.create({
        data: {
          email: `cascade-${Date.now()}@example.test`,
          name: 'Cascade',
        },
      });
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id },
      });

      await prisma.user.delete({ where: { id: user.id } });

      await expect(
        prisma.userRole.count({ where: { userId: user.id } }),
      ).resolves.toBe(0);
    });
  });

  describe('no speculative billing models', () => {
    it('declares no plan, subscription, entitlement, or credit-ledger table', async () => {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
      `;

      const names = rows.map((row) => row.table_name);

      for (const forbidden of [
        'plans',
        'subscriptions',
        'entitlements',
        'credits',
        'credit_ledger',
        'credit_ledgers',
      ]) {
        expect(names).not.toContain(forbidden);
      }
    });

    it('keeps the identity-independent baseline model', async () => {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'app_settings'
      `;

      expect(rows).toHaveLength(1);
    });
  });
});
