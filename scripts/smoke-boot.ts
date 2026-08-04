/**
 * Boots the compiled artifact, waits for liveness, then shuts it down with
 * SIGTERM and asserts a clean exit.
 *
 * This is the guard against path-alias drift: aliases are declared in
 * tsconfig.json and mirrored in .swcrc, and a mismatch there passes lint,
 * typecheck, and unit tests while failing only when the built output actually
 * runs. It doubles as the graceful-shutdown check.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.SMOKE_PORT ?? 3100);
const BOOT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const LIVENESS_URL = `http://127.0.0.1:${PORT}/health/live`;

function start(): ChildProcess {
  return spawn(process.execPath, ['dist/main'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function waitForLiveness(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Application exited during boot with code ${child.exitCode}.`,
      );
    }

    try {
      const response = await fetch(LIVENESS_URL);

      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    await sleep(300);
  }

  throw new Error(`Liveness endpoint not ready within ${BOOT_TIMEOUT_MS}ms.`);
}

async function shutdown(child: ChildProcess): Promise<number> {
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal === 'SIGTERM' ? 0 : 1));
    });
  });

  child.kill('SIGTERM');

  const result = await Promise.race([
    exited,
    sleep(SHUTDOWN_TIMEOUT_MS).then(() => -1),
  ]);

  if (result === -1) {
    child.kill('SIGKILL');
    throw new Error(
      `Process did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM.`,
    );
  }

  return result;
}

async function main(): Promise<void> {
  const child = start();

  try {
    await waitForLiveness(child);
    console.log(`✓ Booted and answered ${LIVENESS_URL}`);

    const exitCode = await shutdown(child);

    if (exitCode !== 0) {
      throw new Error(
        `Expected a clean exit on SIGTERM, got code ${exitCode}.`,
      );
    }

    console.log('✓ Shut down cleanly on SIGTERM');
  } catch (error) {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`✗ Smoke test failed: ${String(error)}`);
  process.exit(1);
});
