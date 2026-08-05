import { RequestContext } from '@common/context/request-context';
import { FEATURE_FLAGS } from '@modules/feature-flags/feature-flags.catalogue';

import { BillingSubjectResolver } from './billing-subject.resolver';

describe('BillingSubjectResolver', () => {
  afterEach(() => {
    // Clear ALS between tests — RequestContext has no reset helper.
    RequestContext.run({ requestId: 'test' }, () => undefined);
  });

  function build(opts?: {
    billingMode?: 'user' | 'organization';
    orgBillingEnabled?: boolean;
  }) {
    const billingMode = opts?.billingMode ?? 'organization';
    const orgBillingEnabled = opts?.orgBillingEnabled ?? true;

    const prisma = {
      organization: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) => {
          if (where.id !== 'org-1') {
            return Promise.resolve(null);
          }
          return Promise.resolve({ id: 'org-1', billingMode });
        }),
      },
    };

    const featureFlags = {
      isEnabled: jest.fn(
        (key: string) =>
          Promise.resolve(
            key === FEATURE_FLAGS.ORG_BILLING ? orgBillingEnabled : false,
          ),
      ),
    };

    const resolver = new BillingSubjectResolver(
      prisma as never,
      featureFlags as never,
    );

    return { resolver, prisma, featureFlags };
  }

  it('defaults to the user when no organization is bound', async () => {
    const { resolver } = build();

    await expect(resolver.resolve('user-1')).resolves.toEqual({
      type: 'user',
      userId: 'user-1',
    });
  });

  it('returns organization subject when org-primary and flag enabled', async () => {
    const { resolver } = build({
      billingMode: 'organization',
      orgBillingEnabled: true,
    });

    await expect(resolver.resolve('user-1', 'org-1')).resolves.toEqual({
      type: 'organization',
      organizationId: 'org-1',
    });
  });

  it('falls back to user when org billingMode is user', async () => {
    const { resolver } = build({ billingMode: 'user' });

    await expect(resolver.resolve('user-1', 'org-1')).resolves.toEqual({
      type: 'user',
      userId: 'user-1',
    });
  });

  it('falls back to user when org.billing flag is off', async () => {
    const { resolver } = build({ orgBillingEnabled: false });

    await expect(resolver.resolve('user-1', 'org-1')).resolves.toEqual({
      type: 'user',
      userId: 'user-1',
    });
  });

  it('reads organization id from RequestContext when override omitted', async () => {
    const { resolver } = build({ billingMode: 'organization' });

    await expect(
      RequestContext.run({ requestId: 'r1', organizationId: 'org-1' }, () =>
        resolver.resolve('user-1'),
      ),
    ).resolves.toEqual({
      type: 'organization',
      organizationId: 'org-1',
    });
  });
});
