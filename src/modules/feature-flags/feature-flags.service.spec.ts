import { FEATURE_FLAGS } from './feature-flags.catalogue';
import { FeatureFlagsService } from './feature-flags.service';

type OverrideRow = {
  id: string;
  flagKey: string;
  enabled: boolean;
  userId: string | null;
  organizationId: string | null;
};

function createService(
  overrides: OverrideRow[] = [],
  envDefaults: Record<string, boolean> = {},
) {
  let idSeq = 0;
  const rows = [...overrides];

  const prisma = {
    featureFlagOverride: {
      findFirst: jest.fn(
        ({
          where,
        }: {
          where: {
            flagKey: string;
            userId?: string | null;
            organizationId?: string | null;
          };
        }) =>
          rows.find(
            (row) =>
              row.flagKey === where.flagKey &&
              (where.userId === undefined || row.userId === where.userId) &&
              (where.organizationId === undefined ||
                row.organizationId === where.organizationId),
          ) ?? null,
      ),
      create: jest.fn(({ data }: { data: Omit<OverrideRow, 'id'> }) => {
        const row: OverrideRow = {
          ...data,
          id: `override-${++idSeq}`,
          userId: data.userId ?? null,
          organizationId: data.organizationId ?? null,
        };
        rows.push(row);
        return row;
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { enabled: boolean };
        }) => {
          const row = rows.find((r) => r.id === where.id)!;
          row.enabled = data.enabled;
          return row;
        },
      ),
      deleteMany: jest.fn(({ where }: { where: Partial<OverrideRow> }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i];
          if (
            row.flagKey === where.flagKey &&
            row.userId === (where.userId ?? null) &&
            row.organizationId === (where.organizationId ?? null)
          ) {
            rows.splice(i, 1);
          }
        }
        return { count: before - rows.length };
      }),
    },
  };

  const service = new FeatureFlagsService(
    prisma as never,
    {
      defaults: envDefaults,
    } as never,
  );

  return { service, rows };
}

describe('FeatureFlagsService', () => {
  it('falls back to the code default when no override or env default exists', async () => {
    const { service } = createService([], {});
    await expect(
      service.isEnabled(FEATURE_FLAGS.EMAIL_LOW_BALANCE),
    ).resolves.toBe(false);
    await expect(service.isEnabled(FEATURE_FLAGS.ORG_BILLING)).resolves.toBe(
      true,
    );
  });

  it('prefers the env default over the code default', async () => {
    const { service } = createService([], {
      [FEATURE_FLAGS.EMAIL_LOW_BALANCE]: true,
    });
    await expect(
      service.isEnabled(FEATURE_FLAGS.EMAIL_LOW_BALANCE),
    ).resolves.toBe(true);
  });

  it('prefers a global DB override over the env default', async () => {
    const { service } = createService(
      [
        {
          id: 'o1',
          flagKey: FEATURE_FLAGS.EMAIL_LOW_BALANCE,
          enabled: true,
          userId: null,
          organizationId: null,
        },
      ],
      { [FEATURE_FLAGS.EMAIL_LOW_BALANCE]: false },
    );
    await expect(
      service.isEnabled(FEATURE_FLAGS.EMAIL_LOW_BALANCE),
    ).resolves.toBe(true);
  });

  it('prefers an org override over a global override', async () => {
    const { service } = createService([
      {
        id: 'o1',
        flagKey: FEATURE_FLAGS.ORG_BILLING,
        enabled: false,
        userId: null,
        organizationId: null,
      },
      {
        id: 'o2',
        flagKey: FEATURE_FLAGS.ORG_BILLING,
        enabled: true,
        userId: null,
        organizationId: 'org-1',
      },
    ]);
    await expect(
      service.isEnabled(FEATURE_FLAGS.ORG_BILLING, { organizationId: 'org-1' }),
    ).resolves.toBe(true);
  });

  it('prefers a user override over an org override', async () => {
    const { service } = createService([
      {
        id: 'o1',
        flagKey: FEATURE_FLAGS.ORG_BILLING,
        enabled: false,
        userId: null,
        organizationId: 'org-1',
      },
      {
        id: 'o2',
        flagKey: FEATURE_FLAGS.ORG_BILLING,
        enabled: true,
        userId: 'user-1',
        organizationId: null,
      },
    ]);
    await expect(
      service.isEnabled(FEATURE_FLAGS.ORG_BILLING, {
        userId: 'user-1',
        organizationId: 'org-1',
      }),
    ).resolves.toBe(true);
  });

  it('rejects an unknown flag key at runtime', async () => {
    const { service } = createService();
    await expect(service.isEnabled('not.a.real.flag' as never)).rejects.toThrow(
      /Unknown feature flag key/,
    );
  });

  it('setOverride creates then updates a scoped override', async () => {
    const { service, rows } = createService();
    await service.setOverride({
      key: FEATURE_FLAGS.ORG_BILLING,
      enabled: false,
      organizationId: 'org-1',
    });
    expect(rows).toHaveLength(1);

    await service.setOverride({
      key: FEATURE_FLAGS.ORG_BILLING,
      enabled: true,
      organizationId: 'org-1',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
  });

  it('clearOverride removes a scoped override', async () => {
    const { service, rows } = createService([
      {
        id: 'o1',
        flagKey: FEATURE_FLAGS.ORG_BILLING,
        enabled: true,
        userId: null,
        organizationId: 'org-1',
      },
    ]);

    await service.clearOverride({
      key: FEATURE_FLAGS.ORG_BILLING,
      organizationId: 'org-1',
    });
    expect(rows).toHaveLength(0);
  });
});
