import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnvFiles } from 'dotenv';

import { PrismaClient } from '../src/generated/prisma/client';

loadEnvFiles({ path: ['.env.local', '.env'], quiet: true });

const SEED_VERSION = '1';

/**
 * Seeds are idempotent — `upsert`, never `create` — so re-running against an
 * already-populated development database is safe and does nothing.
 */
async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: 'seed_version' },
    update: { value: SEED_VERSION },
    create: { key: 'seed_version', value: SEED_VERSION },
  });
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
    console.log(`Seeded (seed_version=${SEED_VERSION}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
