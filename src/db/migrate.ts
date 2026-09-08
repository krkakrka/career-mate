import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { acquireLock, releaseLock } from '../lib/file-lock.js';

const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

interface MigrationRow {
  id: string;
}

/**
 * A migration file starting with this marker gets PRAGMA foreign_keys
 * toggled off around it and a `foreign_key_check` verification after —
 * needed for any migration that recreates a table other tables reference
 * (SQLite has no ALTER COLUMN, so changing e.g. a NOT NULL constraint means
 * drop-and-recreate, and dropping a table that's an FK target performs an
 * implicit cascading DELETE on its children while foreign_keys is on).
 */
const FOREIGN_KEYS_OFF_MARKER = '-- migration-lock: foreign-keys-off';

/** Exported for direct testing of the FK-violation-rolls-back-cleanly path; not part of the public migration API. */
export function applyMigrationFile(db: Database.Database, file: string, sql: string): void {
  const needsForeignKeysOff = sql.startsWith(FOREIGN_KEYS_OFF_MARKER);

  // PRAGMA foreign_keys is a no-op inside a transaction, so this has to
  // happen outside the BEGIN IMMEDIATE below — which is fine, since the
  // caller's file lock (not this transaction) is what provides cross-process
  // exclusivity here.
  if (needsForeignKeysOff) db.pragma('foreign_keys = OFF');

  try {
    const apply = db.transaction(() => {
      db.exec(sql);

      // Checked *inside* the transaction, before the _migrations insert
      // below — PRAGMA foreign_key_check works regardless of the
      // foreign_keys pragma's on/off state, and throwing here rolls the
      // whole transaction back. Checking after apply.immediate() committed
      // (an earlier version of this code did) would mean a real violation
      // is already permanently on disk with the migration already marked
      // applied — never re-checked or reported again, since the next run
      // would see it in _migrations and skip it.
      if (needsForeignKeysOff) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(
            `Migration ${file} would leave dangling foreign key references: ${JSON.stringify(violations)}`,
          );
        }
      }

      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(file);
    });
    apply.immediate();
  } finally {
    if (needsForeignKeysOff) db.pragma('foreign_keys = ON');
  }
}

/**
 * Applies every *.sql file under db/migrations not yet recorded in
 * _migrations, in filename order. The whole run is wrapped in a
 * cross-process exclusive file lock (not just a DB transaction) — a plain
 * BEGIN IMMEDIATE around the batch, which is what earlier versions of this
 * function used, can't be combined with migrations that need
 * PRAGMA foreign_keys=OFF (a no-op inside a transaction), so the lock is
 * what now prevents two processes racing to bootstrap the same fresh DB
 * from double-applying a migration.
 */
export function runMigrations(db: Database.Database): void {
  const lockPath = `${db.name}.migrating.lock`;
  acquireLock(lockPath);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);

    const applied = new Set(
      (db.prepare('SELECT id FROM _migrations').all() as MigrationRow[]).map((row) => row.id),
    );

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      applyMigrationFile(db, file, sql);
    }
  } finally {
    releaseLock(lockPath);
  }
}
