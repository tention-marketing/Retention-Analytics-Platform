// Graceful shutdown for both long-running entry points (the API server and the
// BullMQ worker).
//
// Why this exists: the API server previously installed no signal handler at all,
// so a container SIGTERM killed the process outright — in-flight requests were
// severed mid-response, and the Postgres pool and Redis connection were dropped
// rather than closed. The worker had a handler but no re-entry guard and no
// timeout, so a second signal would double-close and a wedged connection could
// hang the process indefinitely.
//
// Contract:
//   * exit 0 when every closer succeeded
//   * exit 1 when any closer threw, or when the timeout fired
//   * a repeat signal during shutdown is ignored, not re-entered
//   * the process exits by its own `process.exit`, never by the signal — so an
//     orchestrator observes (code 0, signal null) rather than (null, 'SIGTERM')

/** Hard ceiling on shutdown. A connection that never drains must not wedge the process. */
export const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

export interface Closer {
  name: string;
  close: () => Promise<unknown>;
}

export interface ShutdownOptions {
  log?: (message: string, err?: unknown) => void;
  timeoutMs?: number;
  /** Injectable so tests can observe the intended exit code without exiting. */
  onExit?: (code: number) => void;
}

/**
 * Close the given resources in order, then exit. Exported separately from the
 * signal wiring so it can be unit-tested without sending real signals.
 */
export async function runShutdown(
  signal: string,
  closers: Closer[],
  opts: ShutdownOptions = {},
): Promise<number> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = opts.onExit ?? ((code: number) => process.exit(code));

  log(`[shutdown] ${signal} received — closing ${closers.length} resource(s)`);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log(`[shutdown] timed out after ${timeoutMs}ms — forcing exit`);
    exit(1);
  }, timeoutMs);
  // Do not let the timer itself hold the event loop open.
  timer.unref();

  let failed = false;
  // Sequential, not parallel: order matters. Stop serving before tearing down the
  // resources the in-flight handlers are still using.
  for (const c of closers) {
    try {
      await c.close();
      log(`[shutdown] closed ${c.name}`);
    } catch (err) {
      failed = true;
      log(`[shutdown] failed to close ${c.name}`, err);
    }
  }
  clearTimeout(timer);

  if (timedOut) return 1;
  const code = failed ? 1 : 0;
  log(`[shutdown] complete (exit ${code})`);
  exit(code);
  return code;
}

/**
 * Install SIGTERM and SIGINT handlers. Returns a function that triggers the same
 * path manually, which is what the tests use.
 */
export function installGracefulShutdown(
  closers: Closer[],
  opts: ShutdownOptions = {},
): () => Promise<number | void> {
  let shuttingDown = false;

  const handle = async (signal: string): Promise<number | void> => {
    if (shuttingDown) {
      (opts.log ?? console.log)(`[shutdown] ${signal} ignored — already shutting down`);
      return;
    }
    shuttingDown = true;
    return runShutdown(signal, closers, opts);
  };

  process.on('SIGTERM', () => void handle('SIGTERM'));
  process.on('SIGINT', () => void handle('SIGINT'));
  return () => handle('manual');
}

/**
 * Close an ioredis client safely.
 *
 * The shared client uses `lazyConnect`, so on a process that never issued a
 * command it is still in the 'wait' state and `quit()` rejects. Falling back to
 * `disconnect()` keeps shutdown from reporting a spurious failure.
 */
export async function closeRedis(client: {
  status: string;
  quit: () => Promise<unknown>;
  disconnect: () => void;
}): Promise<void> {
  if (client.status === 'end') return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
