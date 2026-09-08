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

/** Spawns the daemon detached if it isn't already running. Returns immediately either way — never waits on it. */
export function ensureDaemonRunning(): void {
  if (isDaemonRunning()) return;

  const child = spawn(process.execPath, [daemonEntryPath()], {
    detached: true,
    stdio: 'ignore',
    cwd: getPackageRoot(),
  });
  child.unref();
}
