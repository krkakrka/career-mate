import { sleepSync } from '../lib/sleep-sync.js';

/**
 * better-sqlite3's busy_timeout pragma covers normal lock-wait retries (e.g.
 * BEGIN IMMEDIATE contending with another writer), but empirically does NOT
 * cover `PRAGMA journal_mode=WAL` on a brand-new database file being opened
 * by two processes at once — that call can throw SQLITE_BUSY immediately
 * rather than waiting. This retries synchronously (better-sqlite3 has no
 * async API to await) with a short backoff.
 */
export function withBusyRetry<T>(fn: () => T, attempts = 20, delayMs = 25): T {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      const isBusy = error instanceof Error && (error as NodeJS.ErrnoException).code === 'SQLITE_BUSY';
      if (!isBusy || attempt === attempts) throw error;
      sleepSync(delayMs);
    }
  }
  throw new Error('unreachable');
}
