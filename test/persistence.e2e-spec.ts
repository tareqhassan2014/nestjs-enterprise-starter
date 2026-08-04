import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '@infrastructure/prisma/prisma.service';

import { createTestApp } from './create-test-app';

/**
 * Integration test: requires the Compose stack (or CI service containers) with
 * migrations applied. See README for the local workflow.
 */
describe('Persistence (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.appSetting.deleteMany({
      where: { key: { startsWith: 'test_' } },
    });
    await app.close();
  });

  it('connects during module initialisation', async () => {
    await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toBeDefined();
  });

  it('round-trips a record', async () => {
    const key = `test_roundtrip_${Date.now()}`;

    await prisma.appSetting.create({
      data: { key, value: { enabled: true, retries: 3 } },
    });

    const found = await prisma.appSetting.findUnique({ where: { key } });

    expect(found).not.toBeNull();
    expect(found?.value).toEqual({ enabled: true, retries: 3 });
  });

  it('sets updatedAt on write', async () => {
    const key = `test_updated_${Date.now()}`;

    const created = await prisma.appSetting.create({
      data: { key, value: 'first' },
    });

    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('raises a known error on a unique-constraint violation', async () => {
    const key = `test_conflict_${Date.now()}`;

    await prisma.appSetting.create({ data: { key, value: 'one' } });

    await expect(
      prisma.appSetting.create({ data: { key, value: 'two' } }),
    ).rejects.toMatchObject({
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });
  });

  it('fails initialisation against an unreachable database', async () => {
    const unreachable = new PrismaService({
      // Port 1 refuses immediately.
      url: 'postgresql://postgres:postgres@127.0.0.1:1/nope',
    });

    await expect(unreachable.onModuleInit()).rejects.toThrow();

    await unreachable.$disconnect().catch(() => undefined);
  });

  it('raises P2025 when updating a record that does not exist', async () => {
    await expect(
      prisma.appSetting.update({
        where: { key: 'test_definitely_absent' },
        data: { value: 'x' },
      }),
    ).rejects.toMatchObject({
      name: 'PrismaClientKnownRequestError',
      code: 'P2025',
    });
  });
});
