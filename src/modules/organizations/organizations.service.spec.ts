import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

import { OrganizationsService } from './organizations.service';

interface MemberRow {
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  createdAt: Date;
}

function createService(): {
  service: OrganizationsService;
  state: {
    organizations: Map<string, { id: string; slug: string; name: string }>;
    members: Map<string, MemberRow>;
  };
} {
  const organizations = new Map<
    string,
    { id: string; slug: string; name: string }
  >();
  const members = new Map<string, MemberRow>();
  const users = new Set(['owner-1', 'admin-1', 'member-1', 'outsider-1']);
  let orgSeq = 0;

  const memberKey = (organizationId: string, userId: string) =>
    `${organizationId}:${userId}`;

  const prisma = {
    organization: {
      findUnique: jest.fn(
        ({ where }: { where: { slug?: string; id?: string } }) => {
          if (where.slug) {
            return (
              [...organizations.values()].find((o) => o.slug === where.slug) ??
              null
            );
          }
          return organizations.get(where.id!) ?? null;
        },
      ),
      create: jest.fn(({ data }: { data: { name: string; slug: string } }) => {
        const org = {
          id: `org-${++orgSeq}`,
          slug: data.slug,
          name: data.name,
        };
        organizations.set(org.id, org);
        return org;
      }),
    },
    organizationMember: {
      create: jest.fn(
        ({
          data,
        }: {
          data: {
            organizationId: string;
            userId: string;
            role: MemberRow['role'];
          };
        }) => {
          const row: MemberRow = { ...data, createdAt: new Date() };
          members.set(memberKey(data.organizationId, data.userId), row);
          return row;
        },
      ),
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: {
            organizationId_userId: { organizationId: string; userId: string };
          };
        }) =>
          members.get(
            memberKey(
              where.organizationId_userId.organizationId,
              where.organizationId_userId.userId,
            ),
          ) ?? null,
      ),
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { organizationId?: string; userId?: string };
        }) => {
          const rows = [...members.values()];
          if (where.organizationId) {
            return rows.filter(
              (r) => r.organizationId === where.organizationId,
            );
          }
          if (where.userId) {
            return rows
              .filter((r) => r.userId === where.userId)
              .map((r) => ({
                ...r,
                organization: organizations.get(r.organizationId),
              }));
          }
          return rows;
        },
      ),
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: {
            organizationId_userId: { organizationId: string; userId: string };
          };
          create: MemberRow;
          update: Partial<MemberRow>;
        }) => {
          const key = memberKey(
            where.organizationId_userId.organizationId,
            where.organizationId_userId.userId,
          );
          const existing = members.get(key);
          const row: MemberRow = existing
            ? { ...existing, ...update }
            : { ...create, createdAt: new Date() };
          members.set(key, row);
          return row;
        },
      ),
      delete: jest.fn(
        ({
          where,
        }: {
          where: {
            organizationId_userId: { organizationId: string; userId: string };
          };
        }) => {
          members.delete(
            memberKey(
              where.organizationId_userId.organizationId,
              where.organizationId_userId.userId,
            ),
          );
        },
      ),
      count: jest.fn(
        ({ where }: { where: { organizationId: string; role: string } }) =>
          [...members.values()].filter(
            (m) =>
              m.organizationId === where.organizationId &&
              m.role === where.role,
          ).length,
      ),
    },
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        users.has(where.id) ? { id: where.id } : null,
      ),
    },
  };

  (prisma as { $transaction?: jest.Mock }).$transaction = jest.fn(
    (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );

  const service = new OrganizationsService(prisma as never);
  return { service, state: { organizations, members } };
}

describe('OrganizationsService', () => {
  it('creates an organization with the creator as owner', async () => {
    const { service, state } = createService();

    const org = await service.create('owner-1', { name: 'Acme', slug: 'acme' });

    expect(org.slug).toBe('acme');
    const membership = state.members.get(`${org.id}:owner-1`);
    expect(membership?.role).toBe('owner');
  });

  it('rejects a duplicate slug', async () => {
    const { service } = createService();
    await service.create('owner-1', { name: 'Acme', slug: 'acme' });

    await expect(
      service.create('admin-1', { name: 'Acme Two', slug: 'acme' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('lets an owner add a member', async () => {
    const { service } = createService();
    const org = await service.create('owner-1', { name: 'Acme', slug: 'acme' });

    const member = await service.addMember('owner-1', org.id, {
      userId: 'member-1',
    });

    expect(member.role).toBe('member');
  });

  it('denies a member from adding another member', async () => {
    const { service } = createService();
    const org = await service.create('owner-1', { name: 'Acme', slug: 'acme' });
    await service.addMember('owner-1', org.id, { userId: 'member-1' });

    await expect(
      service.addMember('member-1', org.id, { userId: 'outsider-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('denies a non-owner admin from granting the owner role', async () => {
    const { service } = createService();
    const org = await service.create('owner-1', { name: 'Acme', slug: 'acme' });
    await service.addMember('owner-1', org.id, {
      userId: 'admin-1',
      role: 'admin',
    });

    await expect(
      service.addMember('admin-1', org.id, {
        userId: 'member-1',
        role: 'owner',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('rejects removing the last owner', async () => {
    const { service } = createService();
    const org = await service.create('owner-1', { name: 'Acme', slug: 'acme' });

    await expect(
      service.removeMember('owner-1', org.id, 'owner-1'),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('reports membership via getMembership', async () => {
    const { service } = createService();
    const org = await service.create('owner-1', { name: 'Acme', slug: 'acme' });

    await expect(
      service.getMembership(org.id, 'owner-1'),
    ).resolves.toMatchObject({
      role: 'owner',
    });
    await expect(
      service.getMembership(org.id, 'outsider-1'),
    ).resolves.toBeNull();
  });

  it('throws NOT_FOUND when adding an unknown user', async () => {
    const { service } = createService();
    const org = await service.create('owner-1', { name: 'Acme', slug: 'acme' });

    await expect(
      service.addMember('owner-1', org.id, { userId: 'ghost' }),
    ).rejects.toBeInstanceOf(ApiException);
  });
});
