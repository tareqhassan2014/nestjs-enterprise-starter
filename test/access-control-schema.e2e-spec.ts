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
        'api-keys:manage',
        'mcp:tools:invoke',
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

  describe('credits and Stripe top-up models', () => {
    it('declares wallet, ledger, and Stripe linkage without Connect/Tax tables', async () => {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
      `;

      const names = rows.map((row) => row.table_name);

      for (const required of [
        'plans',
        'plan_entitlements',
        'plan_usage_limits',
        'subscriptions',
        'credit_wallets',
        'credit_ledger_entries',
        'stripe_customers',
        'stripe_processed_events',
      ]) {
        expect(names).toContain(required);
      }

      for (const forbidden of [
        'invoices',
        'stripe_connect_accounts',
        'tax_registrations',
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

  describe('plan catalogue seed', () => {
    it('seeds lite, pro, and enterprise with entitlement and usage matrices', async () => {
      const planRows = await prisma.plan.findMany({
        include: { entitlements: true, usageLimits: true },
        orderBy: { rank: 'asc' },
      });

      expect(planRows.map((plan) => plan.slug)).toEqual([
        'lite',
        'pro',
        'enterprise',
      ]);

      for (const plan of planRows) {
        expect(
          plan.entitlements.map((row) => row.entitlementKey).sort(),
        ).toEqual(['feature.advanced', 'feature.priority_support'].sort());
        expect(plan.usageLimits.some((row) => row.feature === 'demo')).toBe(
          true,
        );
      }

      const lite = planRows.find((plan) => plan.slug === 'lite')!;
      const pro = planRows.find((plan) => plan.slug === 'pro')!;
      expect(
        lite.entitlements.find(
          (row) => row.entitlementKey === 'feature.advanced',
        )?.enabled,
      ).toBe(false);
      expect(
        pro.entitlements.find(
          (row) => row.entitlementKey === 'feature.advanced',
        )?.enabled,
      ).toBe(true);
    });

    it('rejects a duplicate plan slug', async () => {
      await expect(
        prisma.plan.create({
          data: {
            slug: 'lite',
            name: 'Dup',
            rank: 99,
          },
        }),
      ).rejects.toMatchObject({
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
      });
    });

    it('rejects a duplicate plan entitlement pair', async () => {
      const lite = await prisma.plan.findUniqueOrThrow({
        where: { slug: 'lite' },
      });
      const existing = await prisma.planEntitlement.findFirstOrThrow({
        where: { planId: lite.id },
      });

      await expect(
        prisma.planEntitlement.create({
          data: {
            planId: existing.planId,
            entitlementKey: existing.entitlementKey,
            enabled: true,
          },
        }),
      ).rejects.toMatchObject({
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
      });
    });
  });
});
