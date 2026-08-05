import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { MailRecorder } from '@infrastructure/mail/mail-recorder';
import { PrismaService } from '@infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '@infrastructure/redis/redis.constants';
import {
  type VersionStore,
  advancePermissionVersion,
} from '@modules/authorization/permission-cache-version';
import { PermissionResolver } from '@modules/authorization/permission-resolver.service';

import {
  clearAuthLimiterState,
  createVerifiedUser,
  grantRole,
  revokeRole,
  type TestUser,
} from './auth-helpers';
import { createTestApp } from './create-test-app';
import { AuthorizationFixtureModule } from './fixtures/authorization-fixture.module';

/**
 * Integration test: requires the Compose stack with migrations applied and the
 * seed run, since the baseline roles and permission catalogue come from it.
 */
describe('Authorization (integration)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: MailRecorder;
  let resolver: PermissionResolver;
  /** The raw client, for invalidating the way a script outside Nest would. */
  let redis: VersionStore;

  /** Holds the `user` role: authority over its own account only. */
  let member: TestUser;
  /** Holds `admin`: every declared permission. */
  let admin: TestUser;
  /** Holds no role at all. */
  let roleless: TestUser;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp(undefined, [AuthorizationFixtureModule]);
    prisma = app.get(PrismaService);
    mail = app.get(MailRecorder);
    resolver = app.get(PermissionResolver);
    redis = app.get(REDIS_CLIENT);

    await clearAuthLimiterState(app.get(REDIS_CLIENT));

    const deps = { app, prisma, mail };

    member = await createVerifiedUser(deps, 'authz-member');
    admin = await createVerifiedUser(deps, 'authz-admin');
    roleless = await createVerifiedUser(deps, 'authz-roleless');
    createdUserIds.push(member.userId, admin.userId, roleless.userId);

    await grantRole(prisma, member.userId, 'user');
    await grantRole(prisma, admin.userId, 'admin');
    await resolver.invalidate();
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const as = (path: string, user: TestUser) =>
    get(path).set('Cookie', user.cookie);

  describe('deny by default', () => {
    it('rejects an unannotated route with no session', async () => {
      const response = await get('/api/v1/authz-fixture/unannotated');

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    });

    it('allows an unannotated route to an authenticated caller', async () => {
      const response = await as('/api/v1/authz-fixture/unannotated', roleless);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ data: { reached: true } });
    });

    it('allows a @Public() route with no session', async () => {
      const response = await get('/api/v1/authz-fixture/public');

      expect(response.status).toBe(200);
    });

    it('keeps health probes reachable without credentials', async () => {
      await expect(get('/health/live').then((r) => r.status)).resolves.toBe(
        200,
      );
      await expect(get('/health/ready').then((r) => r.status)).resolves.toBe(
        200,
      );
    });

    it('rejects a garbage session rather than trusting it', async () => {
      const response = await get('/api/v1/authz-fixture/unannotated').set(
        'Cookie',
        'app.session_token=not-a-real-token',
      );

      expect(response.status).toBe(401);
    });
  });

  describe('both session transports', () => {
    it('authenticates via the cookie', async () => {
      const response = await as('/api/v1/authz-fixture/authenticated', member);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ email: member.email });
    });

    it('authenticates via the bearer token, as the same user', async () => {
      const response = await get('/api/v1/authz-fixture/authenticated').set(
        'Authorization',
        `Bearer ${member.token}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: member.userId,
        email: member.email,
      });
    });
  });

  describe('permission requirements', () => {
    it('permits a caller holding the required permission', async () => {
      const response = await as('/api/v1/authz-fixture/own-account', member);

      expect(response.status).toBe(200);
    });

    it('refuses a caller lacking it, without describing the policy', async () => {
      const response = await as('/api/v1/authz-fixture/list-users', member);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      });

      // The body must not enumerate what was required or missing.
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('user:list');
      expect(response.body.error.details).toBeUndefined();
    });

    it('refuses a caller with no roles at all', async () => {
      const response = await as('/api/v1/authz-fixture/own-account', roleless);

      expect(response.status).toBe(403);
    });

    it('requires every listed permission, not any of them', async () => {
      // admin holds both; member holds neither.
      await expect(
        as('/api/v1/authz-fixture/two-permissions', admin).then(
          (r) => r.status,
        ),
      ).resolves.toBe(200);

      await expect(
        as('/api/v1/authz-fixture/two-permissions', member).then(
          (r) => r.status,
        ),
      ).resolves.toBe(403);
    });

    it('resolves the access set once when two requirements are evaluated', async () => {
      const spy = jest.spyOn(resolver, 'resolve');

      const response = await as('/api/v1/authz-fixture/two-checks', member);

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });
  });

  describe('role requirements', () => {
    it('accepts any one of the listed roles', async () => {
      await expect(
        as('/api/v1/authz-fixture/either-role', member).then((r) => r.status),
      ).resolves.toBe(200);

      await expect(
        as('/api/v1/authz-fixture/either-role', admin).then((r) => r.status),
      ).resolves.toBe(200);
    });

    it('refuses a caller holding none of them', async () => {
      const response = await as('/api/v1/authz-fixture/admin-role', member);

      expect(response.status).toBe(403);
    });
  });

  describe('annotation precedence', () => {
    it('inherits a controller-level requirement', async () => {
      await expect(
        as('/api/v1/authz-inherited/inherits', admin).then((r) => r.status),
      ).resolves.toBe(200);

      await expect(
        as('/api/v1/authz-inherited/inherits', member).then((r) => r.status),
      ).resolves.toBe(403);
    });

    it('lets a method-level requirement override the controller', async () => {
      // member lacks role:manage but holds account:read, so the override decides.
      const response = await as('/api/v1/authz-inherited/overrides', member);

      expect(response.status).toBe(200);
    });
  });

  describe('runtime-editable assignments', () => {
    it('grants a permission when a role is assigned', async () => {
      await expect(
        as('/api/v1/authz-fixture/own-account', roleless).then((r) => r.status),
      ).resolves.toBe(403);

      await grantRole(prisma, roleless.userId, 'user');
      await resolver.invalidate();

      await expect(
        as('/api/v1/authz-fixture/own-account', roleless).then((r) => r.status),
      ).resolves.toBe(200);
    });

    it('revokes it when the role is removed', async () => {
      await grantRole(prisma, roleless.userId, 'user');
      await resolver.invalidate();
      await expect(
        as('/api/v1/authz-fixture/own-account', roleless).then((r) => r.status),
      ).resolves.toBe(200);

      await revokeRole(prisma, roleless.userId, 'user');
      await resolver.invalidate();

      await expect(
        as('/api/v1/authz-fixture/own-account', roleless).then((r) => r.status),
      ).resolves.toBe(403);
    });

    it('observes a mapping change without a redeploy', async () => {
      /**
       * Mutates a role created for this test rather than the seeded `user` role.
       * Jest runs suites in parallel workers and other suites assert on the
       * seeded mappings, so editing shared state here made those assertions fail
       * intermittently — a worse problem than the one being tested.
       */
      const scratchRole = await prisma.role.create({
        data: {
          name: `scratch-authz-${Date.now()}`,
          description: 'Created by the authorization suite; safe to delete.',
        },
      });

      const permission = await prisma.permission.findUniqueOrThrow({
        where: { key: 'user:list' },
      });

      try {
        await prisma.userRole.create({
          data: { userId: roleless.userId, roleId: scratchRole.id },
        });
        await resolver.invalidate();

        await expect(
          as('/api/v1/authz-fixture/list-users', roleless).then(
            (r) => r.status,
          ),
        ).resolves.toBe(403);

        // Grant the permission at runtime, as an operator would.
        await prisma.rolePermission.create({
          data: { roleId: scratchRole.id, permissionId: permission.id },
        });
        await resolver.invalidate();

        await expect(
          as('/api/v1/authz-fixture/list-users', roleless).then(
            (r) => r.status,
          ),
        ).resolves.toBe(200);
      } finally {
        // Cascades take the mapping and the assignment with the role.
        await prisma.role.delete({ where: { id: scratchRole.id } });
        await resolver.invalidate();
      }
    });

    /**
     * Invalidation through the path a script uses, not the injected service.
     *
     * Every other case here calls `resolver.invalidate()`, which needs the Nest
     * container. That made "a mutation is observed on the next request" a property
     * of the test harness: the seed rewrites role mappings, has no container, and
     * never advanced the marker — so re-seeding a running environment changed the
     * database and changed nothing a caller could see until the cache expired.
     *
     * This calls `advancePermissionVersion` with a plain client, exactly as
     * `prisma/seed.ts` now does, so the mechanism the seed depends on is the one
     * under test.
     */
    it('observes a mapping change invalidated from outside the container', async () => {
      const scratchRole = await prisma.role.create({
        data: {
          name: `scratch-outside-${Date.now()}`,
          description: 'Created by the authorization suite; safe to delete.',
        },
      });

      const permission = await prisma.permission.findUniqueOrThrow({
        where: { key: 'user:list' },
      });

      try {
        await prisma.userRole.create({
          data: { userId: roleless.userId, roleId: scratchRole.id },
        });
        await advancePermissionVersion(redis);

        // Warm the cache under the current marker, so the assertion below can
        // only pass if the marker actually advanced.
        await expect(
          as('/api/v1/authz-fixture/list-users', roleless).then(
            (r) => r.status,
          ),
        ).resolves.toBe(403);

        await prisma.rolePermission.create({
          data: { roleId: scratchRole.id, permissionId: permission.id },
        });
        await advancePermissionVersion(redis);

        await expect(
          as('/api/v1/authz-fixture/list-users', roleless).then(
            (r) => r.status,
          ),
        ).resolves.toBe(200);
      } finally {
        await prisma.role.delete({ where: { id: scratchRole.id } });
        await advancePermissionVersion(redis);
      }
    });

    it('gives a user with two roles the union of their permissions', async () => {
      await grantRole(prisma, roleless.userId, 'user');
      await grantRole(prisma, roleless.userId, 'admin');
      await resolver.invalidate();

      const access = await resolver.resolve(roleless.userId);

      expect(access.roles.sort()).toEqual(['admin', 'user']);
      expect(access.permissions).toContain('account:read');
      expect(access.permissions).toContain('user:list');

      // Union, so no duplicates even though both roles grant account:read.
      expect(new Set(access.permissions).size).toBe(access.permissions.length);

      await revokeRole(prisma, roleless.userId, 'admin');
      await revokeRole(prisma, roleless.userId, 'user');
      await resolver.invalidate();
    });
  });

  describe('cache behaviour', () => {
    it('serves a permitted caller when the cache is unavailable', async () => {
      const redis = (
        resolver as unknown as { redis: { get: (key: string) => unknown } }
      ).redis;

      const failing = jest
        .spyOn(redis, 'get')
        .mockRejectedValue(new Error('redis is down') as never);

      try {
        const response = await as('/api/v1/authz-fixture/own-account', member);

        // Falls through to Postgres rather than denying.
        expect(response.status).toBe(200);
      } finally {
        failing.mockRestore();
      }
    });

    it('never reads an entry written under a superseded version', async () => {
      const access = await resolver.resolve(member.userId);
      expect(access.permissions).toContain('account:read');

      await resolver.invalidate();

      // A fresh resolve after the bump must reflect the database, not the entry
      // cached under the previous version.
      const afterBump = await resolver.resolve(member.userId);
      expect(afterBump.permissions).toContain('account:read');
    });
  });
});
