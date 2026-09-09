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
 *
 * Synchronous and blocking via Atomics.wait — acceptable for migrations,
 * which run once at process startup (openDb(), before the daemon's event
 * loop has any other work to do). NOT acceptable for anything used from
 * inside a running daemon's job handlers: see acquireLockAsync below.
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

/**
 * Same locking semantics as acquireLock, but waits via `await` instead of
 * a synchronous Atomics.wait busy-loop. Required for locks taken from
 * inside a running daemon's job handlers (e.g. the browser-profile lock in
 * src/browser/profile.ts): the daemon is a single-threaded Node process
 * juggling multiple job topics concurrently, and a synchronous wait would
 * freeze that whole thread — starving unrelated topics like notifications
 * — for as long as the lock is contended (which, for the browser profile,
 * can be minutes: `cm auth login-browser` holds it for an entire
 * interactive login session).
 */
export async function acquireLockAsync(lockPath: string, timeoutMs = 10_000, pollMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = tryClaimFile(lockPath, process.pid);
    if (result === 'claimed') return;
    if (result === 'retry') continue;

    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for lock at ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone — fine.
  }
}
