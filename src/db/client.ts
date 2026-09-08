import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '../lib/paths.js';
import { withBusyRetry } from './busy-retry.js';
import { runMigrations } from './migrate.js';

/**
 * Opens (creating if necessary) a career-mate SQLite database at the given
 * path, sets WAL mode + foreign keys + a busy timeout (so concurrent access
 * from the CLI, the daemon, and its workers waits instead of erroring), and
 * brings it up to date. Exposed separately from getDb() so tests can point
 * at an isolated temp file without going through CM_DATA_DIR / the
 * process-wide singleton.
 */
export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  // busy_timeout must be set first: it's what makes every pragma/statement
  // below (including the WAL-mode switch itself) wait and retry on a lock
  // instead of throwing SQLITE_BUSY immediately.
  db.pragma('busy_timeout = 5000');
  withBusyRetry(() => db.pragma('journal_mode = WAL'));
  db.pragma('foreign_keys = ON');

  try {
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

let dbInstance: Database.Database | undefined;

/** The process-wide DB handle, opened lazily against CM_DATA_DIR (or ./.data). */
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  dbInstance = openDb(path.join(dataDir, 'career-mate.db'));
  return dbInstance;
}

export function closeDb(): void {
  dbInstance?.close();
  dbInstance = undefined;
}
