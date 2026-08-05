import { createHash } from 'node:crypto';

import { ApiKeyService } from './api-key.service';

describe('ApiKeyService', () => {
  const userId = 'user-1';

  function buildService(prismaOverrides?: Record<string, unknown>) {
    const created: {
      id: string;
      userId: string;
      name: string;
      prefix: string;
      secretHash: string;
      createdAt: Date;
      lastUsedAt: Date | null;
      revokedAt: Date | null;
      updatedAt: Date;
    } = {
      id: 'key-1',
      userId,
      name: 'Cursor',
      prefix: 'nes_deadbeef',
      secretHash: 'hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: null,
      revokedAt: null,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    let storedSecret = '';

    const prisma = {
      apiKey: {
        create: jest.fn(({ data }: { data: Record<string, string> }) => {
          storedSecret = ''; // plaintext never stored
          created.prefix = data.prefix;
          created.secretHash = data.secretHash;
          created.name = data.name;
          return Promise.resolve({ ...created });
        }),
        findMany: jest.fn(() => Promise.resolve([{ ...created }])),
        findFirst: jest.fn(
          ({ where }: { where: { id: string; userId: string } }) => {
            if (where.userId !== userId) {
              return Promise.resolve(null);
            }
            return Promise.resolve({ ...created, id: where.id });
          },
        ),
        findUnique: jest.fn(({ where }: { where: { prefix: string } }) => {
          if (where.prefix !== created.prefix) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            ...created,
            secretHash: createHash('sha256')
              .update(storedSecret || 'placeholder', 'utf8')
              .digest('hex'),
          });
        }),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...created,
            ...data,
          }),
        ),
      },
      user: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: userId,
            email: 'a@example.com',
            name: 'A',
            emailVerified: true,
            twoFactorEnabled: false,
          }),
        ),
      },
      ...prismaOverrides,
    };

    const permissions = {
      resolve: jest.fn().mockResolvedValue({
        roles: ['user'],
        permissions: ['api-keys:manage', 'mcp:tools:invoke'],
      }),
    };

    const service = new ApiKeyService(prisma as never, permissions as never);

    return {
      service,
      prisma,
      permissions,
      created,
      setStoredSecret: (s: string) => {
        storedSecret = s;
      },
    };
  }

  it('create returns plaintext once and list omits it', async () => {
    const { service, prisma } = buildService();

    const created = await service.create(userId, 'Cursor');
    expect(created.secret).toMatch(/^nes_[a-f0-9]+$/);
    expect(created.prefix).toBe(created.secret.slice(0, 12));
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prefix: created.prefix,
          secretHash: expect.any(String),
          name: 'Cursor',
        }),
      }),
    );

    const listed = await service.listForUser(userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
    expect(listed[0]).not.toHaveProperty('secretHash');
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it('verify succeeds then fails after revoke', async () => {
    const { service, setStoredSecret, created } = buildService();
    const made = await service.create(userId, 'Cursor');
    setStoredSecret(made.secret);

    // Align prefix used by findUnique with the created secret.
    created.prefix = made.prefix;

    const principal = await service.verifySecret(made.secret);
    expect(principal?.user.id).toBe(userId);
    expect(principal?.apiKeyId).toBe('key-1');

    await service.revoke(userId, 'key-1');
    created.revokedAt = new Date();

    await expect(service.verifySecret(made.secret)).resolves.toBeNull();
  });

  it('cross-user revoke returns not found', async () => {
    const { service } = buildService();
    await expect(service.revoke('other-user', 'key-1')).rejects.toBeDefined();
  });
});
