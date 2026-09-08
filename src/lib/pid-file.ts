import fs from 'node:fs';

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send a signal — it just checks the process exists and is signalable.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFromFile(filePath: string): number | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const pid = Number(content);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export type ClaimResult = 'claimed' | 'blocked' | 'retry';

/**
 * Attempts to exclusively claim `filePath` for `pid` via exclusive create
 * (EEXIST if already there). If it's already claimed, checks whether the
 * recorded holder is still alive: a live holder means 'blocked' (caller
 * should wait or give up); a dead one is a stale lock left by a process
 * that crashed without cleaning up — it's removed here and 'retry' is
 * returned so the caller immediately attempts the claim again, rather than
 * waiting out a lock nothing will ever release.
 *
 * Shared by daemon-pid.ts's claimPidFile (single-attempt: claimed or
 * yield) and file-lock.ts's acquireLock (retries with backoff until
 * claimed or timeout) — same primitive, different consumption pattern.
 */
export function tryClaimFile(filePath: string, pid: number): ClaimResult {
  try {
    fs.writeFileSync(filePath, String(pid), { flag: 'wx' });
    return 'claimed';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const holderPid = readPidFromFile(filePath);
  if (holderPid !== undefined && isProcessAlive(holderPid)) {
    return 'blocked';
  }

  try {
    fs.unlinkSync(filePath);
  } catch {
    // Raced with another process also clearing/reclaiming it — fine, caller retries either way.
  }
  return 'retry';
}
