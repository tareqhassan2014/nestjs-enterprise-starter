import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnvFiles } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client';
import {
  BASELINE_ROLES,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
} from '../src/modules/authorization/permissions';

loadEnvFiles({ path: ['.env.local', '.env'], quiet: true });

const SEED_VERSION = '2';

/**
 * Seeds are idempotent — `upsert`, never `create` — so re-running against an
 * already-populated development database is safe and does nothing.
 *
 * For the access-control tables, idempotency rests on the composite unique
 * constraints in the schema rather than on bookkeeping here: `RolePermission`
 * and `UserRole` cannot hold a duplicate, so a concurrent or repeated run is
 * safe by construction.
 */
async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: 'seed_version' },
    update: { value: SEED_VERSION },
    create: { key: 'seed_version', value: SEED_VERSION },
  });

  await seedAccessControl(prisma);
}

/**
 * Mirrors the code-declared catalogue into the database, then asserts the
 * baseline roles and their grants.
 *
 * Permissions removed from the code declaration are deliberately left in place:
 * they are already inert (no annotation can name them), and deleting rows would
 * cascade away grants an operator may have made intentionally. Cleaning them up
 * is an explicit administrative act, not a side effect of seeding.
 */
async function seedAccessControl(prisma: PrismaClient): Promise<void> {
  for (const key of PERMISSIONS) {
    const description = PERMISSION_DESCRIPTIONS[key];

    await prisma.permission.upsert({
      where: { key },
      update: { description },
      create: { key, description },
    });
  }

  for (const [name, definition] of Object.entries(BASELINE_ROLES)) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { description: definition.description },
      create: { name, description: definition.description },
    });

    for (const permissionKey of definition.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { key: permissionKey },
      });

      // The composite unique makes this a no-op on a second run.
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    await seed(prisma);
    console.log(
      `Seeded (seed_version=${SEED_VERSION}, ${PERMISSIONS.length} permissions, ` +
        `${Object.keys(BASELINE_ROLES).length} baseline roles).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
