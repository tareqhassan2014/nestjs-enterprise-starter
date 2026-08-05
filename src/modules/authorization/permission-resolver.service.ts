import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { RequestContext } from '@common/context/request-context';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';

import {
  PERMISSION_CACHE_TTL_SECONDS,
  advancePermissionVersion,
  readPermissionVersion,
} from './permission-cache-version';

export interface EffectiveAccess {
  roles: string[];
  permissions: string[];
}

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
   * The mechanism lives in `permission-cache-version.ts` so the seed and any
   * operator tooling can advance the same marker without a Nest container — see
   * the note there. This method is the in-process entry point to it, not a second
   * implementation.
   */
  async invalidate(): Promise<void> {
    try {
      await advancePermissionVersion(this.redis);
    } catch (error: unknown) {
      // Without Redis there is no cache to invalidate, so there is nothing to
      // get wrong: reads are already falling through to Postgres.
      this.degraded('invalidate', error);
    }
  }

  private async currentVersion(): Promise<number | null> {
    try {
      return await readPermissionVersion(this.redis);
    } catch (error: unknown) {
      this.degraded('version read', error);
      return null;
    }
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
        PERMISSION_CACHE_TTL_SECONDS,
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
