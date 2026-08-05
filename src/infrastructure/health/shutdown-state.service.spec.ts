import { ShutdownState } from './shutdown-state.service';

describe('ShutdownState', () => {
  it('starts as not shutting down', () => {
    const state = new ShutdownState();
    expect(state.isShuttingDown).toBe(false);
  });

  it('flips to shutting down once the shutdown lifecycle hook fires', () => {
    const state = new ShutdownState();
    state.beforeApplicationShutdown();
    expect(state.isShuttingDown).toBe(true);
  });
});
