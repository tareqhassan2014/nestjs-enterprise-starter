import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { RequestContext } from '@common/context/request-context';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

export interface EffectiveAccess {
  roles: string[];
  permissions: string[];
}

/** Bumped by any role, mapping, or assignment change; see `invalidate()`. */
const VERSION_KEY = 'authz:version';
const CACHE_TTL_SECONDS = 300;

@Injectable()
export class PermissionResolver {
  private readonly logger = new Logger(PermissionResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * The caller's roles and the union of those roles' permissions.
   *
   * Served from cache when possible, and from Postgres otherwise — including
   * whenever Redis errors. A cache problem must degrade latency, never deny a
   * request that the authoritative store would have allowed, which is the same
   * posture the session cache takes.
   */
  async resolve(userId: string): Promise<EffectiveAccess> {
    const version = await this.currentVersion();

    if (version !== null) {
      const cached = await this.readCache(userId, version);

      if (cached) {
        return cached;
      }
    }

    const access = await this.readDatabase(userId);

    if (version !== null) {
      await this.writeCache(userId, version, access);
    }

    return access;
  }

  /**
   * Invalidates every cached permission set by advancing the version.
   *
   * A bump rather than a delete: a single role's mapping can affect thousands of
   * users, and there is no key to enumerate for "everyone who holds this role".
   * Entries written under the previous version simply become unreachable and
   * expire on their TTL. Costs memory for a few minutes; never serves stale.
   */
  async invalidate(): Promise<void> {
    try {
      await this.redis.incr(await this.ensureVersionKey());
    } catch (error: unknown) {
      // Without Redis there is no cache to invalidate, so there is nothing to
      // get wrong: reads are already falling through to Postgres.
      this.degraded('invalidate', error);
    }
  }

  private async currentVersion(): Promise<number | null> {
    try {
      const key = await this.ensureVersionKey();
      const raw = await this.redis.get(key);

      return raw === null ? null : Number.parseInt(raw, 10);
    } catch (error: unknown) {
      this.degraded('version read', error);
      return null;
    }
  }

  /**
   * Seeds the version from the current clock the first time it is needed.
   *
   * Deliberately not from zero. If the version key is lost — eviction, a flush,
   * a fresh Redis — restarting at zero could make entries written under an
   * earlier version readable again, resurrecting stale permissions. Seeding from
   * a timestamp makes the counter monotonic across restarts: it can only ever
   * jump forward.
   */
  private async ensureVersionKey(): Promise<string> {
    await this.redis.set(VERSION_KEY, `${Date.now()}`, 'NX');
    return VERSION_KEY;
  }

  private async readCache(
    userId: string,
    version: number,
  ): Promise<EffectiveAccess | null> {
    try {
      const raw = await this.redis.get(this.cacheKey(userId, version));

      return raw === null ? null : (JSON.parse(raw) as EffectiveAccess);
    } catch (error: unknown) {
      this.degraded('read', error);
      return null;
    }
  }

  private async writeCache(
    userId: string,
    version: number,
    access: EffectiveAccess,
  ): Promise<void> {
    try {
      await this.redis.set(
        this.cacheKey(userId, version),
        JSON.stringify(access),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch (error: unknown) {
      this.degraded('write', error);
    }
  }

  private cacheKey(userId: string, version: number): string {
    return `authz:perm:${userId}:${version}`;
  }

  private async readDatabase(userId: string): Promise<EffectiveAccess> {
    const assignments = await this.prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: { permissions: { include: { permission: true } } },
        },
      },
    });

    const roles = assignments.map((assignment) => assignment.role.name);

    const permissions = new Set<string>();
    for (const assignment of assignments) {
      for (const mapping of assignment.role.permissions) {
        permissions.add(mapping.permission.key);
      }
    }

    return { roles, permissions: [...permissions] };
  }

  private degraded(operation: string, error: unknown): void {
    this.logger.warn({
      msg: `Permission cache ${operation} failed; resolving from the database`,
      requestId: RequestContext.getRequestId(),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
