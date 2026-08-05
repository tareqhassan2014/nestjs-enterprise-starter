import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnvFiles } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client';
import {
  BASELINE_ROLES,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
} from '../src/modules/authorization/permissions';
import { ENTITLEMENT_LIST } from '../src/modules/plans/entitlements';
import { PLAN_SEEDS } from '../src/modules/plans/plan-seeds';
import { USAGE_FEATURES } from '../src/modules/usage-limits/usage-features';

loadEnvFiles({ path: ['.env.local', '.env'], quiet: true });

const SEED_VERSION = '3';

const USAGE_FEATURE_VALUES = Object.values(USAGE_FEATURES);

/**
 * Seeds are idempotent — `upsert`, never `create` — so re-running against an
 * already-populated development database is safe and does nothing.
 *
 * For access-control and plan-matrix tables, idempotency rests on composite
 * unique constraints in the schema rather than on bookkeeping here.
 */
async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: 'seed_version' },
    update: { value: SEED_VERSION },
    create: { key: 'seed_version', value: SEED_VERSION },
  });

  await seedAccessControl(prisma);
  await seedPlans(prisma);
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

/**
 * Upserts Lite / Pro / Enterprise with full entitlement and usage-limit
 * matrices. Every code-declared entitlement and usage feature must appear on
 * every seeded plan — gaps are programming errors, not silent omissions.
 */
async function seedPlans(prisma: PrismaClient): Promise<void> {
  for (const definition of PLAN_SEEDS) {
    for (const key of ENTITLEMENT_LIST) {
      if (definition.entitlements[key] === undefined) {
        throw new Error(
          `Plan seed "${definition.slug}" is missing entitlement "${key}".`,
        );
      }
    }

    for (const feature of USAGE_FEATURE_VALUES) {
      if (!definition.usageLimits[feature]) {
        throw new Error(
          `Plan seed "${definition.slug}" is missing usage limits for "${feature}".`,
        );
      }
    }

    const plan = await prisma.plan.upsert({
      where: { slug: definition.slug },
      update: {
        name: definition.name,
        description: definition.description,
        rank: definition.rank,
        isActive: definition.isActive,
      },
      create: {
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        rank: definition.rank,
        isActive: definition.isActive,
      },
    });

    for (const key of ENTITLEMENT_LIST) {
      await prisma.planEntitlement.upsert({
        where: {
          planId_entitlementKey: {
            planId: plan.id,
            entitlementKey: key,
          },
        },
        update: { enabled: definition.entitlements[key] },
        create: {
          planId: plan.id,
          entitlementKey: key,
          enabled: definition.entitlements[key],
        },
      });
    }

    for (const feature of USAGE_FEATURE_VALUES) {
      const limits = definition.usageLimits[feature];

      await prisma.planUsageLimit.upsert({
        where: {
          planId_feature: {
            planId: plan.id,
            feature,
          },
        },
        update: {
          dailyLimit: limits.dailyLimit,
          weeklyLimit: limits.weeklyLimit,
        },
        create: {
          planId: plan.id,
          feature,
          dailyLimit: limits.dailyLimit,
          weeklyLimit: limits.weeklyLimit,
        },
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
        `${Object.keys(BASELINE_ROLES).length} baseline roles, ` +
        `${PLAN_SEEDS.length} plans, ${ENTITLEMENT_LIST.length} entitlements).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
