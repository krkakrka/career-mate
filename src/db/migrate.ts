import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

interface MigrationRow {
  id: string;
}

/**
 * Applies every *.sql file under db/migrations not yet recorded in
 * _migrations, in filename order. The read of what's already applied and
 * every migration's apply-and-record happen inside one BEGIN IMMEDIATE
 * transaction, so two processes racing to open the same fresh DB (e.g. the
 * CLI and the daemon it just spawned) serialize instead of both seeing an
 * empty _migrations table and double-applying the same migration.
 */
export function runMigrations(db: Database.Database): void {
  const applyPending = db.transaction(() => {
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
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(file);
    }
  });

  applyPending.immediate();
}
