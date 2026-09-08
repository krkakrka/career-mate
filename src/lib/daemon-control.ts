import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, readPidFile } from './daemon-pid.js';
import { getPackageRoot } from './paths.js';

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

  const child = spawn(process.execPath, [daemonEntryPath()], {
    detached: true,
    stdio: 'ignore',
    cwd: getPackageRoot(),
  });
  child.unref();
}
