import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './paths.js';

function pidFilePath(): string {
  return path.join(getDataDir(), 'daemon.pid');
}

export type PidClaimResult = { claimed: true } | { claimed: false; existingPid: number };

/**
 * Atomically claims the pid file via exclusive create (fails with EEXIST if
 * it's already there) rather than an unconditional write. This is what
 * makes two daemons spawned at nearly the same instant (a race
 * ensureDaemonRunning's own check-then-spawn can't fully prevent across
 * separate processes) resolve safely: only one wins the claim, and the
 * loser calls this, sees the winner's live pid, and should exit — instead
 * of both processes overwriting the file and one becoming an orphan no
 * `cm daemon stop` can find.
 */
export function claimPidFile(pid: number): PidClaimResult {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const filePath = pidFilePath();

  for (;;) {
    try {
      fs.writeFileSync(filePath, String(pid), { flag: 'wx' });
      return { claimed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const existingPid = readPidFile();
    if (existingPid !== undefined && isProcessAlive(existingPid)) {
      return { claimed: false, existingPid };
    }
    // Stale pid file left by a process that died without cleaning up — take over.
    removePidFile();
  }
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(pidFilePath());
  } catch {
    // already gone — fine.
  }
}

export function readPidFile(): number | undefined {
  try {
    const content = fs.readFileSync(pidFilePath(), 'utf-8').trim();
    const pid = Number(content);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send a signal — it just checks the process exists and is signalable.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
