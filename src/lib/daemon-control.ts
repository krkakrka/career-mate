import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, readPidFile } from './daemon-pid.js';
import { getDataDir, getPackageRoot } from './paths.js';

function daemonEntryPath(): string {
  // This file lives at src/lib/daemon-control.ts, so two levels up is the project root.
  return fileURLToPath(new URL('../../bin/cm-daemon.js', import.meta.url));
}

export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  return pid !== undefined && isProcessAlive(pid);
}

/**
 * Spawns the daemon detached if it isn't already running. Returns
 * immediately either way — never waits on it.
 *
 * Respects CM_DISABLE_DAEMON_AUTOSTART: every `cm` invocation that enqueues
 * a job (roles/companies add, rerun-enrichment) calls this, and without an
 * opt-out, every test exercising those commands — including the ones from
 * steps 3-4 that predate enrichment entirely — would spawn a real daemon
 * that hits the real network and real claude -p. test/helpers/run-cli.ts
 * sets this by default; tests that actually want to exercise daemon
 * auto-start pass `allowDaemonAutostart: true` to opt back in.
 */
export function ensureDaemonRunning(): void {
  if (process.env.CM_DISABLE_DAEMON_AUTOSTART) return;
  if (isDaemonRunning()) return;
  spawnDaemon();
}

export type StartDaemonResult =
  | { started: true; pid: number }
  | { started: false; reason: 'already-running'; pid: number }
  | { started: false; reason: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null; output: string }
  | { started: false; reason: 'timeout'; output: string };

/**
 * How long an explicit `cm daemon start` waits for the child's `ready`
 * before giving up on confirming it. Generous on purpose: a cold boot is
 * tsx + migrations + the handler imports, and a loaded machine has been
 * seen to take multiples of a second for that.
 */
const START_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * The explicit `cm daemon start` path: spawns, then waits until the child
 * reports that it is up — or died trying.
 *
 * `ensureDaemonRunning` deliberately never waits, because it runs inside
 * every command that enqueues a job. But a command whose whole purpose is
 * starting the daemon must not say "started" about a process that was
 * already dead: the first version did, and a daemon crashing on boot was
 * only discoverable by knowing to open `.data/daemon.log`.
 *
 * "Running" means the daemon said so. The pid file is claimed early in
 * startup — before the stale-job sweep and the handler registry, either of
 * which can throw — so a pid-file check confirms only that the process
 * existed for an instant, and the first draft of this reported success
 * a few milliseconds before the child died. The child sends `ready` over
 * an IPC channel once its poll loop is actually up; that is the signal.
 *
 * The log is shared and append-only across runs, so the failure output
 * returned here is the slice written *after* this spawn — not the tail,
 * which could belong to a previous daemon.
 *
 * Does not honour `CM_DISABLE_DAEMON_AUTOSTART`: that opt-out exists so
 * ordinary commands do not spawn a daemon as a side effect; an explicit
 * start is not a side effect.
 */
export function startDaemon(): Promise<StartDaemonResult> {
  const existing = readPidFile();
  if (existing !== undefined && isProcessAlive(existing)) {
    return Promise.resolve({ started: false, reason: 'already-running', pid: existing });
  }

  // Opened here, not inside spawnDaemon, because opening may rotate the
  // file — and the offset has to be measured on the file the child will
  // actually write to.
  const logPath = daemonLogPath();
  const log = openDaemonLog();
  const logOffset = fs.fstatSync(log).size;
  const child = spawnDaemon(log, { ipc: true });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: StartDaemonResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.removeListener('close', onClose);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      // The channel is the only thing tying the daemon to this process;
      // once it is closed the daemon is as detached as one ensureDaemonRunning spawned.
      try {
        child.disconnect();
      } catch {
        // already closed by the child exiting
      }
      resolve(result);
    };

    // A spawn failure (ENOENT, EAGAIN) surfaces as 'error' on the next
    // tick; unhandled, it would crash this process with a stack instead of
    // the message this command exists to give.
    const onError = (error: Error): void => {
      finish({ started: false, reason: 'exited', exitCode: null, signal: null, output: String(error) });
    };
    child.on('error', onError);

    // 'close', not 'exit': 'exit' can fire while a `ready` the child wrote
    // just before exiting is still queued on the channel; 'close' waits for
    // the channel to drain. Either still fires on an unref'd child as long
    // as this process is alive to hear it — and the open channel keeps it so.
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      // A child that found another daemon already holding the pid file
      // exits 0 by design — the caller lost a race, not the daemon.
      const holder = readPidFile();
      if (code === 0 && holder !== undefined && holder !== child.pid && isProcessAlive(holder)) {
        finish({ started: false, reason: 'already-running', pid: holder });
        return;
      }
      // The log is written by the child directly (it holds the fd), so by
      // the time exit is observed everything it printed is on disk.
      finish({ started: false, reason: 'exited', exitCode: code, signal, output: readFrom(logPath, logOffset) });
    };
    child.on('close', onClose);

    const onMessage = (message: unknown): void => {
      if (message === DAEMON_READY_MESSAGE && child.pid !== undefined) finish({ started: true, pid: child.pid });
    };
    child.on('message', onMessage);

    const deadline = setTimeout(() => {
      finish({ started: false, reason: 'timeout', output: readFrom(logPath, logOffset) });
    }, START_CONFIRM_TIMEOUT_MS);
  });
}

/** What the daemon sends over IPC once its poll loop is up; only meaningful when spawned by `startDaemon`. */
export const DAEMON_READY_MESSAGE = 'ready';

export function daemonLogPath(): string {
  return path.join(getDataDir(), 'daemon.log');
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Everything appended to `file` since it was `offset` bytes long — the current daemon's output, not its predecessors'. */
function readFrom(file: string, offset: number): string {
  try {
    const size = sizeOf(file);
    if (size <= offset) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      return buffer.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Spawns the daemon detached, writing to `log`, and closes this process's copy of the fd. */
function spawnDaemon(log = openDaemonLog(), options: { ipc?: boolean } = {}): ChildProcess {
  const child = spawn(process.execPath, [daemonEntryPath()], {
    detached: true,
    // stdout/stderr go to .data/daemon.log rather than /dev/null: the
    // daemon is where terminal-channel notifications get printed and where
    // a crash prints its stack, and discarding all of that made "the
    // daemon did nothing and I don't know why" unanswerable.
    stdio: options.ipc ? ['ignore', log, log, 'ipc'] : ['ignore', log, log],
    cwd: getPackageRoot(),
  });
  child.unref();
  fs.closeSync(log);
  return child;
}

/** 5 MB, after which the log is rolled to `.1`. One generation is enough for "what did the daemon just do". */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function openDaemonLog(): number {
  const logPath = daemonLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  try {
    if (fs.statSync(logPath).size >= MAX_LOG_BYTES) {
      // Rotate rather than truncate, so whatever was being investigated
      // when the limit was hit is still readable.
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // No log yet (or an unreadable one) — the append below creates it.
  }

  return fs.openSync(logPath, 'a');
}
