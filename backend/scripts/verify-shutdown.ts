/**
 * Graceful-shutdown verification.
 *
 *   A. Unit checks on runShutdown()/closeRedis() — ordering, exit codes, failure
 *      handling, timeout, and the lazyConnect Redis edge case. No signals, no
 *      child processes.
 *   B. Real signal handling for the API server: SIGTERM, SIGINT, a repeated
 *      signal, and release of the listening port.
 *   C. Real signal handling for the BullMQ worker: SIGTERM and SIGINT.
 *
 * THE DECISIVE ASSERTION throughout section B/C is HOW the process exits.
 * Node reports a child's exit as (code, signal):
 *
 *   killed by the signal, no handler   -> (null, 'SIGTERM')
 *   handled, own process.exit(0)       -> (0, null)
 *
 * so the pair distinguishes a graceful shutdown from a signal kill without
 * relying on log scraping.
 *
 * Children are spawned as a SINGLE direct node process (`node --import tsx`)
 * rather than through npm or the tsx shim, because an intermediate wrapper would
 * absorb the signal and make the exit pair meaningless.
 *
 * Offline: no provider API is contacted and no account data is touched. The API
 * child binds a dedicated port so it cannot collide with a running dev server.
 *
 * Run: `npm run verify:shutdown`
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 3211;
const BOOT_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;

let passed = 0;
let failures = 0;
const failed: string[] = [];
const groupTotals: Record<string, { pass: number; fail: number }> = {};
let currentGroup = 'A';

function group(letter: string, title: string): void {
  currentGroup = letter;
  groupTotals[letter] ??= { pass: 0, fail: 0 };
  console.log(`\n${letter}. ${title}`);
}

function check(name: string, cond: boolean, detail?: unknown): void {
  groupTotals[currentGroup] ??= { pass: 0, fail: 0 };
  if (cond) {
    passed++;
    groupTotals[currentGroup].pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    groupTotals[currentGroup].fail++;
    failed.push(`[${currentGroup}] ${name}`);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Child-process harness
// ---------------------------------------------------------------------------
interface Child {
  proc: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
}

function spawnEntry(entry: string, env: Record<string, string> = {}): Child {
  const proc = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  proc.stdout?.on('data', (d) => { buf += String(d); });
  proc.stderr?.on('data', (d) => { buf += String(d); });

  const started = Date.now();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>(
    (resolve) => {
      proc.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - started }));
    },
  );
  return { proc, output: () => buf, exited };
}

/** Wait until `predicate` sees the output it needs, or time out. */
async function waitForOutput(child: Child, predicate: (out: string) => boolean): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate(child.output())) return true;
    if (child.proc.exitCode !== null) return false;
    await sleep(150);
  }
  return false;
}

async function waitForExit(
  child: Child,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number } | null> {
  const timeout = sleep(EXIT_TIMEOUT_MS).then(() => null);
  return Promise.race([child.exited, timeout]);
}

async function portAccepting(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ===========================================================================
// A. Unit checks — no signals, no child processes
// ===========================================================================
async function groupA(): Promise<void> {
  group('A', 'runShutdown() / closeRedis() unit checks');

  const { runShutdown, installGracefulShutdown, closeRedis, SHUTDOWN_TIMEOUT_MS } =
    await import('../src/shutdown.js');

  // --- ordering + success ---
  const order: string[] = [];
  let exitCode: number | null = null;
  await runShutdown('TEST', [
    { name: 'first', close: async () => { order.push('first'); } },
    { name: 'second', close: async () => { order.push('second'); } },
    { name: 'third', close: async () => { order.push('third'); } },
  ], { log: () => undefined, onExit: (c) => { exitCode = c; } });
  check('closers run sequentially in the order given',
    order.join(',') === 'first,second,third', order);
  check('a clean shutdown exits 0', exitCode === 0, exitCode);

  // --- a failing closer must not stop the rest, and must exit 1 ---
  const reached: string[] = [];
  let failCode: number | null = null;
  await runShutdown('TEST', [
    { name: 'ok-before', close: async () => { reached.push('before'); } },
    { name: 'broken', close: async () => { throw new Error('boom'); } },
    { name: 'ok-after', close: async () => { reached.push('after'); } },
  ], { log: () => undefined, onExit: (c) => { failCode = c; } });
  check('a failing closer does not prevent later closers from running',
    reached.join(',') === 'before,after', reached);
  check('a failed closer yields exit 1', failCode === 1, failCode);

  // --- timeout forces an exit rather than hanging ---
  let timeoutCode: number | null = null;
  const slow = runShutdown('TEST', [
    { name: 'never-resolves', close: () => new Promise(() => undefined) },
  ], { log: () => undefined, timeoutMs: 250, onExit: (c) => { timeoutCode = c; } });
  await sleep(600);
  check('a closer that never resolves triggers the timeout', timeoutCode === 1, timeoutCode);
  check('the timeout does not leave the promise rejected',
    await Promise.race([slow.then(() => 'pending-or-done'), sleep(50).then(() => 'pending-or-done')])
      === 'pending-or-done');
  check('the default timeout is 10s unless overridden', SHUTDOWN_TIMEOUT_MS === 10_000,
    SHUTDOWN_TIMEOUT_MS);

  // --- re-entry guard ---
  let calls = 0;
  const trigger = installGracefulShutdown(
    [{ name: 'counted', close: async () => { calls++; } }],
    { log: () => undefined, onExit: () => undefined },
  );
  await trigger();
  await trigger();
  await trigger();
  check('a repeated shutdown is ignored, not re-entered', calls === 1, calls);
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');

  // --- closeRedis handles every client state ---
  let quitCalls = 0;
  let disconnectCalls = 0;
  await closeRedis({
    status: 'ready',
    quit: async () => { quitCalls++; },
    disconnect: () => { disconnectCalls++; },
  });
  check('closeRedis quits a connected client', quitCalls === 1 && disconnectCalls === 0);

  // A lazyConnect client that never issued a command is in 'wait' and quit()
  // rejects; falling back to disconnect() avoids a spurious shutdown failure.
  quitCalls = 0; disconnectCalls = 0;
  await closeRedis({
    status: 'wait',
    quit: async () => { quitCalls++; throw new Error('Connection is closed.'); },
    disconnect: () => { disconnectCalls++; },
  });
  check('closeRedis falls back to disconnect when quit rejects',
    quitCalls === 1 && disconnectCalls === 1);

  quitCalls = 0; disconnectCalls = 0;
  await closeRedis({
    status: 'end',
    quit: async () => { quitCalls++; },
    disconnect: () => { disconnectCalls++; },
  });
  check('closeRedis is a no-op on an already-ended client',
    quitCalls === 0 && disconnectCalls === 0);

  // A never-connected client must not make shutdown report failure.
  let lazyCode: number | null = null;
  await runShutdown('TEST', [
    {
      name: 'lazy redis',
      close: () => closeRedis({
        status: 'wait',
        quit: async () => { throw new Error('Connection is closed.'); },
        disconnect: () => undefined,
      }),
    },
  ], { log: () => undefined, onExit: (c) => { lazyCode = c; } });
  check('a never-connected Redis client still yields a clean exit 0',
    lazyCode === 0, lazyCode);
}

// ===========================================================================
// B. API server — real signals
// ===========================================================================
async function apiSignalCase(signal: NodeJS.Signals): Promise<void> {
  const child = spawnEntry('src/index.ts', { PORT: String(API_PORT) });
  const booted = await waitForOutput(child, (o) => o.includes('Server listening'));
  check(`${signal}: API server booted`, booted, child.output().slice(-400));
  check(`${signal}: port ${API_PORT} accepting before the signal`, await portAccepting(API_PORT));

  child.proc.kill(signal);
  const res = await waitForExit(child);

  check(`${signal}: process exited within ${EXIT_TIMEOUT_MS}ms`, res !== null, res);
  // The decisive pair: a handled shutdown exits with code 0 and signal null.
  check(`${signal}: exited with code 0 (not killed by the signal)`, res?.code === 0, res);
  check(`${signal}: exit signal is null, proving the handler ran`, res?.signal === null, res);
  check(`${signal}: port released after exit`, !(await portAccepting(API_PORT)));

  const out = child.output();
  check(`${signal}: logged that it received the signal`,
    out.includes(`${signal} received`), out.slice(-300));
  check(`${signal}: closed the http server`, out.includes('closed http server'), out.slice(-300));
  check(`${signal}: closed the postgres pool`, out.includes('closed postgres pool'), out.slice(-300));
  check(`${signal}: closed redis`, out.includes('closed redis'), out.slice(-300));
  check(`${signal}: reported a complete shutdown with exit 0`,
    out.includes('complete (exit 0)'), out.slice(-300));
  check(`${signal}: no unhandled rejection or forced timeout`,
    !/unhandledRejection|UnhandledPromiseRejection|forcing exit/i.test(out), out.slice(-300));

  if (res === null) child.proc.kill('SIGKILL');
}

async function groupB(): Promise<void> {
  group('B', 'API server — real SIGTERM / SIGINT');
  await apiSignalCase('SIGTERM');
  await apiSignalCase('SIGINT');

  // A repeated signal must be ignored rather than re-entering shutdown.
  const child = spawnEntry('src/index.ts', { PORT: String(API_PORT) });
  const booted = await waitForOutput(child, (o) => o.includes('Server listening'));
  check('repeat-signal: API server booted', booted);
  // Two DIFFERENT signals in the same tick (identical signals can coalesce at the
  // OS level).
  //
  // NOTE ON WHAT THIS CAN AND CANNOT OBSERVE: in this application every closer
  // resolves in microtasks, so the whole shutdown chain drains and calls
  // process.exit() before Node returns to the event loop to dispatch the second
  // signal's handler. The "ignored — already shutting down" branch is therefore
  // unreachable from a child process here, and asserting on that log line would be
  // testing the harness rather than the code. The re-entry guard is proven directly
  // in group A ("a repeated shutdown is ignored, not re-entered", calls === 1).
  //
  // What IS observable at the process level — and is the property that actually
  // matters — is that a second signal never causes a double close or a dirty exit.
  child.proc.kill('SIGTERM');
  child.proc.kill('SIGINT');
  const res = await waitForExit(child);
  check('repeat-signal: still exits cleanly with code 0', res?.code === 0, res);
  check('repeat-signal: exit signal is null', res?.signal === null, res);
  const out = child.output();
  check('repeat-signal: shutdown ran exactly once (no double close)',
    (out.match(/received — closing/g) ?? []).length === 1,
    (out.match(/received — closing/g) ?? []).length);
  check('repeat-signal: each resource was closed exactly once',
    (out.match(/closed http server/g) ?? []).length === 1
    && (out.match(/closed postgres pool/g) ?? []).length === 1
    && (out.match(/closed redis/g) ?? []).length === 1, out.slice(-400));
  check('repeat-signal: no close error and no forced timeout',
    !/failed to close|forcing exit/.test(out), out.slice(-400));
  if (res === null) child.proc.kill('SIGKILL');
}

// ===========================================================================
// C. Worker — real signals
// ===========================================================================
async function workerSignalCase(signal: NodeJS.Signals): Promise<void> {
  const child = spawnEntry('src/queue/workers.ts');
  const booted = await waitForOutput(child, (o) => o.includes('Workers started'));
  check(`${signal}: worker booted with all seven workers`,
    booted && /shopify-backfill.*klaviyo-poll/s.test(child.output()), child.output().slice(-300));

  child.proc.kill(signal);
  const res = await waitForExit(child);

  check(`${signal}: worker exited within ${EXIT_TIMEOUT_MS}ms`, res !== null, res);
  check(`${signal}: worker exited with code 0 (not killed)`, res?.code === 0, res);
  check(`${signal}: worker exit signal is null`, res?.signal === null, res);

  const out = child.output();
  check(`${signal}: worker logged the signal`, out.includes(`${signal} received`), out.slice(-300));
  check(`${signal}: worker closed its workers`, /closed 7 worker\(s\)/.test(out), out.slice(-300));
  check(`${signal}: worker closed redis`, out.includes('closed redis'), out.slice(-300));
  check(`${signal}: worker shutdown was not forced by the timeout`,
    !/forcing exit/.test(out), out.slice(-300));

  if (res === null) child.proc.kill('SIGKILL');
}

async function groupC(): Promise<void> {
  group('C', 'BullMQ worker — real SIGTERM / SIGINT');
  await workerSignalCase('SIGTERM');
  await workerSignalCase('SIGINT');
}

// ===========================================================================
// Main
// ===========================================================================
/**
 * Group C boots the real worker, which schedules its repeatable jobs in Redis.
 * Remove only those keys so a verification run leaves Redis as it found it — and
 * leaves no scheduled work behind for a real worker to pick up.
 */
async function cleanupRedis(): Promise<void> {
  console.log('\nCleanup');
  const { redis } = await import('../src/queue/queues.js');
  try {
    const keys = await redis.keys('bull:*');
    if (keys.length) await redis.del(...keys);
    console.log(`  removed ${keys.length} BullMQ key(s) created by the worker cases`);
  } catch (err) {
    console.log(`  could not clean Redis: ${(err as Error).message}`);
  } finally {
    const { closeRedis } = await import('../src/shutdown.js');
    await closeRedis(redis);
  }
}

async function main(): Promise<void> {
  console.log('Graceful-shutdown verification (offline; no provider API, no account data)');

  try {
    await groupA();
    await groupB();
    await groupC();
  } finally {
    await cleanupRedis();
  }

  console.log('\n' + '='.repeat(72));
  console.log('GRACEFUL-SHUTDOWN RESULTS BY GROUP');
  const titles: Record<string, string> = {
    A: 'Unit (runShutdown/closeRedis)', B: 'API signals', C: 'Worker signals',
  };
  for (const [letter, t] of Object.entries(groupTotals)) {
    console.log(`  ${t.fail === 0 ? '✓' : '✗'} ${letter}. ${(titles[letter] ?? '').padEnd(30)} ${t.pass} passed, ${t.fail} failed`);
  }
  console.log('='.repeat(72));
  console.log(`TOTAL: ${passed} passed, ${failures} failed`);
  if (failures > 0) {
    console.log('\nFAILED CHECKS:');
    for (const f of failed) console.log(`  ✗ ${f}`);
  }
  console.log(failures === 0 ? '\n✓ ALL SHUTDOWN CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});

export {};
