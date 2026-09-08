import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './paths.js';
import { isProcessAlive, readPidFromFile, tryClaimFile } from './pid-file.js';

export { isProcessAlive };

function pidFilePath(): string {
  return path.join(getDataDir(), 'daemon.pid');
}

export type PidClaimResult = { claimed: true } | { claimed: false; existingPid: number };

/**
 * Atomically claims the pid file (see pid-file.ts's tryClaimFile). This is
 * what makes two daemons spawned at nearly the same instant (a race
 * ensureDaemonRunning's own check-then-spawn can't fully prevent across
 * separate processes) resolve safely: only one wins the claim, and the
 * loser sees the winner's live pid and should exit — instead of both
 * processes overwriting the file and one becoming an orphan no
 * `cm daemon stop` can find.
 */
export function claimPidFile(pid: number): PidClaimResult {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const filePath = pidFilePath();

  for (;;) {
    const result = tryClaimFile(filePath, pid);
    if (result === 'claimed') return { claimed: true };
    if (result === 'retry') continue; // stale lock just cleared — try again immediately

    const existingPid = readPidFile();
    if (existingPid === undefined) continue; // holder exited between the check and now — retry
    return { claimed: false, existingPid };
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
  return readPidFromFile(pidFilePath());
}
