import { HttpStatus } from '@nestjs/common';

import { ApiException } from '@common/errors/api-exception';
import { ErrorCode } from '@common/errors/error-code';

import { assertUsageFeature, USAGE_FEATURES } from './usage-features';
import { UsageLimitsService, type UsageSubject } from './usage-limits.service';

function serviceWith(
  redis: Partial<{
    mget: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    decr: jest.Mock;
  }>,
  ceilings = { daily: 3, weekly: 10 },
): UsageLimitsService {
  return new UsageLimitsService(redis as never, {
    default: ceilings,
    features: { demo: ceilings },
  });
}

describe('UsageLimitsService', () => {
  const subject: UsageSubject = { userId: 'user-1' };

  it('rejects unknown features as a programming error', () => {
    expect(() => assertUsageFeature('not-a-feature')).toThrow(/Unknown usage/);
    expect(() => assertUsageFeature(USAGE_FEATURES.DEMO)).not.toThrow();
  });

  it('builds user and org keys for a period stamp', () => {
    const service = serviceWith({});
    const at = new Date('2026-08-05T12:00:00Z');
    const day = service.periodStamp('day', at);
    const keys = service.keysFor(
      { userId: 'u1', orgId: 'o1' },
      USAGE_FEATURES.DEMO,
      'day',
      at,
    );

    expect(day).toBe('2026-08-05');
    expect(keys).toEqual([
      `usage:day:${day}:demo:u:u1`,
      `usage:day:${day}:demo:o:o1`,
    ]);
  });

  it('omits org keys when orgId is absent', () => {
    const service = serviceWith({});
    const keys = service.keysFor(subject, USAGE_FEATURES.DEMO, 'week');

    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(':u:user-1');
    expect(keys[0]).not.toContain(':o:');
  });

  it('computes seconds until the next UTC midnight', () => {
    const service = serviceWith({});
    const at = new Date('2026-08-05T23:00:00.000Z');
    expect(service.secondsUntilPeriodEnd('day', at)).toBe(3600);
  });

  it('throws USAGE_LIMIT_EXCEEDED with Retry-After when daily is exhausted', async () => {
    const service = serviceWith({
      mget: jest.fn().mockResolvedValue(['3']),
    });

    await expect(
      service.consume(subject, USAGE_FEATURES.DEMO, ['day']),
    ).rejects.toMatchObject({
      code: ErrorCode.USAGE_LIMIT_EXCEEDED,
      status: HttpStatus.TOO_MANY_REQUESTS,
      headers: expect.objectContaining({ 'Retry-After': expect.any(String) }),
      details: expect.objectContaining({ feature: 'demo', period: 'day' }),
    });
  });

  it('increments when under the ceiling', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const expire = jest.fn().mockResolvedValue(1);
    const service = serviceWith({
      mget: jest.fn().mockResolvedValue(['0']),
      incr,
      expire,
    });

    await service.consume(subject, USAGE_FEATURES.DEMO, ['day']);

    expect(incr).toHaveBeenCalled();
    expect(expire).toHaveBeenCalled();
  });

  it('fails closed with SERVICE_UNAVAILABLE when Redis errors', async () => {
    const service = serviceWith({
      mget: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await expect(
      service.check(subject, USAGE_FEATURES.DEMO, 'day'),
    ).rejects.toBeInstanceOf(ApiException);

    await expect(
      service.check(subject, USAGE_FEATURES.DEMO, 'day'),
    ).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});
