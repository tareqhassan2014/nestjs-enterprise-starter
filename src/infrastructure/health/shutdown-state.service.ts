import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';

/**
 * Flips to "shutting down" as early as possible in the Nest shutdown
 * lifecycle (`beforeApplicationShutdown`, which runs ahead of
 * `onApplicationShutdown`) so the readiness probe can fail fast while
 * queue/connection draining is still in progress. This gives an
 * orchestrator time to stop routing new traffic before in-flight work
 * finishes draining.
 */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }
}
