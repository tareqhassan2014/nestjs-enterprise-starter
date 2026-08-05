import {
  userSubject,
  organizationSubject,
} from '@modules/organizations/billing-subject';
import type { FeatureFlagsService } from '@modules/feature-flags/feature-flags.service';

import { LowBalanceEmailListener } from './low-balance-email.listener';
import type { EmailQueueService } from './email-queue.service';

function build(options: {
  flagEnabled: boolean;
  configEnabled: boolean;
  user?: { email: string } | null;
  owner?: { user: { email: string } } | null;
}): {
  listener: LowBalanceEmailListener;
  enqueueEmail: jest.Mock;
} {
  const enqueueEmail = jest.fn().mockResolvedValue(undefined);
  const featureFlags = {
    isEnabled: jest.fn().mockResolvedValue(options.flagEnabled),
  } as unknown as FeatureFlagsService;
  const emailQueue = { enqueueEmail } as unknown as EmailQueueService;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(options.user ?? null),
    },
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue(options.owner ?? null),
    },
  };

  const listener = new LowBalanceEmailListener(
    featureFlags,
    emailQueue,
    prisma as never,
    { emailLowBalanceEnabled: options.configEnabled } as never,
  );

  return { listener, enqueueEmail };
}

describe('LowBalanceEmailListener', () => {
  it('enqueues an email for a user subject when the flag is enabled', async () => {
    const { listener, enqueueEmail } = build({
      flagEnabled: true,
      configEnabled: false,
      user: { email: 'user@example.com' },
    });

    await listener.handle({
      subject: userSubject('u1'),
      userId: 'u1',
      balance: 1,
      threshold: 5,
    });

    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@example.com' }),
    );
  });

  it('enqueues an email for an organization subject via the owner', async () => {
    const { listener, enqueueEmail } = build({
      flagEnabled: false,
      configEnabled: true,
      owner: { user: { email: 'owner@example.com' } },
    });

    await listener.handle({
      subject: organizationSubject('org-1'),
      balance: 1,
      threshold: 5,
    });

    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@example.com' }),
    );
  });

  it('does nothing when both the flag and the config toggle are off', async () => {
    const { listener, enqueueEmail } = build({
      flagEnabled: false,
      configEnabled: false,
      user: { email: 'user@example.com' },
    });

    await listener.handle({
      subject: userSubject('u1'),
      userId: 'u1',
      balance: 1,
      threshold: 5,
    });

    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('does nothing when no recipient can be resolved', async () => {
    const { listener, enqueueEmail } = build({
      flagEnabled: true,
      configEnabled: false,
      user: null,
    });

    await listener.handle({
      subject: userSubject('ghost'),
      userId: 'ghost',
      balance: 1,
      threshold: 5,
    });

    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});
