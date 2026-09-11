import { spawn } from 'node:child_process';
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

  const log = openDaemonLog();
  const child = spawn(process.execPath, [daemonEntryPath()], {
    detached: true,
    // stdout/stderr go to .data/daemon.log rather than /dev/null: the
    // daemon is where terminal-channel notifications get printed and where
    // a crash prints its stack, and discarding all of that made "the
    // daemon did nothing and I don't know why" unanswerable.
    stdio: ['ignore', log, log],
    cwd: getPackageRoot(),
  });
  child.unref();
  fs.closeSync(log);
}

/** 5 MB, after which the log is rolled to `.1`. One generation is enough for "what did the daemon just do". */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function openDaemonLog(): number {
  const logPath = path.join(getDataDir(), 'daemon.log');
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
