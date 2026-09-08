import fs from 'node:fs';
import { tryClaimFile } from './pid-file.js';
import { sleepSync } from './sleep-sync.js';

/**
 * A blocking, cross-process exclusive lock backed by tryClaimFile (same
 * exclusive-create + stale-holder-recovery primitive daemon-pid.ts's
 * claimPidFile uses, generalized to an arbitrary path). Used where a
 * critical section needs real mutual exclusion across processes and can't
 * rely on a SQLite transaction alone — e.g. migrations that must toggle
 * `PRAGMA foreign_keys`, which is a no-op inside a transaction, so the
 * usual BEGIN IMMEDIATE serialization trick doesn't apply. Stale-holder
 * recovery matters here specifically: without it, a process killed while
 * holding this lock (crash, OOM, power loss) would permanently deadlock
 * every future `cm` invocation, since migrations run on every openDb().
 */
export function acquireLock(lockPath: string, timeoutMs = 10_000, pollMs = 25): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = tryClaimFile(lockPath, process.pid);
    if (result === 'claimed') return;
    if (result === 'retry') continue; // stale lock just cleared — try again immediately

    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for lock at ${lockPath}`);
    }
    sleepSync(pollMs);
  }
}

export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone — fine.
  }
}
