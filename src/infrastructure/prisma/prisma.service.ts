import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig } from '@config/database.config';
import { PrismaClient } from '@/generated/prisma/client';

/**
 * The application's database client.
 *
 * Prisma 7 requires a driver adapter — the no-argument constructor throws — so
 * the connection string arrives through the validated `database` config
 * namespace rather than Prisma reading process.env behind our backs.
 *
 * Connecting during module init means a bad DATABASE_URL fails the boot instead
 * of the first request that happens to touch the database.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Inject(databaseConfig.KEY)
    config: ConfigType<typeof databaseConfig>,
  ) {
    super({ adapter: new PrismaPg({ connectionString: config.url }) });
  }

  /**
   * `$connect()` alone is not enough under Prisma 7: the pg driver adapter
   * opens connections lazily, so an unreachable or misconfigured database
   * resolves here and only fails on the first real query. The probe query is
   * what actually makes a bad DATABASE_URL fail the boot rather than the first
   * request that happens to touch the database.
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$queryRaw`SELECT 1`;
  }

  /**
   * Paired with `app.enableShutdownHooks()`. Prisma's `beforeExit` hook was
   * removed for the library engine in Prisma 5 and is deliberately not used.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
