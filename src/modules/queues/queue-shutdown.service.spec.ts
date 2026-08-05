import type { Queue } from 'bullmq';

import { QueueShutdownService } from './queue-shutdown.service';

function queueWith(activeCount: number, disconnect = jest.fn()): Queue {
  return {
    getActiveCount: jest.fn().mockResolvedValue(activeCount),
    disconnect: disconnect.mockResolvedValue(undefined),
  } as unknown as Queue;
}

describe('QueueShutdownService', () => {
  it('returns immediately without disconnecting when every queue is idle', async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const service = new QueueShutdownService(
      queueWith(0, disconnect),
      queueWith(0, disconnect),
      queueWith(0, disconnect),
      { drainMs: 5000 } as never,
    );

    await service.onApplicationShutdown();

    expect(disconnect).not.toHaveBeenCalled();
  });

  it('force-disconnects queue clients once the drain window elapses with jobs still active', async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const service = new QueueShutdownService(
      queueWith(1, disconnect),
      queueWith(0, disconnect),
      queueWith(0, disconnect),
      { drainMs: 50 } as never,
    );

    await service.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(3);
  }, 10_000);
});
