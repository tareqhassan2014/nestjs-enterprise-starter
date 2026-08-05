import { AuditLogService, AUDIT_ACTIONS } from './audit-log.service';

describe('AuditLogService', () => {
  const create = jest.fn();
  const findMany = jest.fn();

  const prisma = {
    adminAuditLog: { create, findMany },
  };

  let service: AuditLogService;

  beforeEach(() => {
    create.mockReset();
    findMany.mockReset();
    service = new AuditLogService(prisma as never);
  });

  it('writes an append-only audit row', async () => {
    const row = {
      id: 'a1',
      actorUserId: 'actor',
      action: AUDIT_ACTIONS.CREDITS_ADJUST,
      targetType: 'user',
      targetId: 'target',
      summary: 'Adjusted',
      metadata: null,
      requestId: 'req-1',
      createdAt: new Date(),
    };
    create.mockResolvedValue(row);

    await expect(
      service.write({
        actorUserId: 'actor',
        action: AUDIT_ACTIONS.CREDITS_ADJUST,
        targetType: 'user',
        targetId: 'target',
        summary: 'Adjusted',
        requestId: 'req-1',
      }),
    ).resolves.toEqual(row);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'actor',
        action: AUDIT_ACTIONS.CREDITS_ADJUST,
        targetId: 'target',
      }),
    });
  });

  it('lists with filters and capped page size', async () => {
    findMany.mockResolvedValue([]);

    await service.list({
      action: AUDIT_ACTIONS.CREDITS_GRANT,
      actorUserId: 'actor',
      limit: 500,
      offset: 0,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: AUDIT_ACTIONS.CREDITS_GRANT,
          actorUserId: 'actor',
        }),
        take: 100,
        skip: 0,
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('writeSafe swallows persistence errors', async () => {
    create.mockRejectedValue(new Error('db down'));
    await expect(
      service.writeSafe({
        actorUserId: 'actor',
        action: AUDIT_ACTIONS.CREDITS_GRANT,
        summary: 'Grant',
      }),
    ).resolves.toBeUndefined();
  });
});
