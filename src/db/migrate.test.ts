import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProcessAlive } from '../lib/pid-file.js';
import { openDb } from './client.js';
import { applyMigrationFile, runMigrations } from './migrate.js';

const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-migrate-'));
  dbPath = path.join(tempDir, 'career-mate.db');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Opens a raw connection and applies ONLY 0001, bypassing runMigrations, to simulate a pre-0002 database. */
function openAtV1(): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
  const sql = fs.readFileSync(path.join(migrationsDir, '0001_init.sql'), 'utf-8');
  db.exec(sql);
  db.prepare('INSERT INTO _migrations (id) VALUES (?)').run('0001_init.sql');
  return db;
}

describe('0002_nullable_role_company migration', () => {
  it('preserves all pre-existing data (company, role, and every FK-dependent child row) across the recreate', () => {
    const v1 = openAtV1();

    const companyId = v1.prepare('INSERT INTO companies (url, name) VALUES (?, ?)').run(
      'https://example.com',
      'Example Co',
    ).lastInsertRowid as number;
    const roleId = v1.prepare('INSERT INTO roles (company_id, url, title) VALUES (?, ?, ?)').run(
      companyId,
      'https://example.com/jobs/1',
      'Engineer',
    ).lastInsertRowid as number;
    v1.prepare('INSERT INTO role_status_history (role_id, from_status, to_status, context) VALUES (?, ?, ?, ?)').run(
      roleId,
      null,
      'new',
      'initial',
    );
    v1.prepare('INSERT INTO role_references (role_id, type, file_path) VALUES (?, ?, ?)').run(
      roleId,
      'cv',
      '/tmp/cv.pdf',
    );
    v1.prepare('INSERT INTO tips (scope, role_id, content, sources) VALUES (?, ?, ?, ?)').run(
      'role',
      roleId,
      'some tips',
      '[]',
    );
    v1.prepare('INSERT INTO recruiter_contacts (role_id, recruiter_name) VALUES (?, ?)').run(roleId, 'Jane Recruiter');
    v1.prepare('INSERT INTO interview_notes (role_id, notes) VALUES (?, ?)').run(roleId, 'went well');
    v1.close();

    // Now run the real migration path, which will see 0001 already applied and apply 0002.
    const migrated = openDb(dbPath);

    const company = migrated.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as {
      name: string;
    };
    expect(company.name).toBe('Example Co');

    const role = migrated.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as {
      company_id: number;
      title: string;
    };
    expect(role.company_id).toBe(companyId);
    expect(role.title).toBe('Engineer');

    const historyCount = migrated.prepare('SELECT COUNT(*) as c FROM role_status_history WHERE role_id = ?').get(
      roleId,
    ) as { c: number };
    const referencesCount = migrated.prepare('SELECT COUNT(*) as c FROM role_references WHERE role_id = ?').get(
      roleId,
    ) as { c: number };
    const tipsCount = migrated.prepare('SELECT COUNT(*) as c FROM tips WHERE role_id = ?').get(roleId) as {
      c: number;
    };
    const contactsCount = migrated.prepare('SELECT COUNT(*) as c FROM recruiter_contacts WHERE role_id = ?').get(
      roleId,
    ) as { c: number };
    const notesCount = migrated.prepare('SELECT COUNT(*) as c FROM interview_notes WHERE role_id = ?').get(
      roleId,
    ) as { c: number };

    expect(historyCount.c).toBe(1);
    expect(referencesCount.c).toBe(1);
    expect(tipsCount.c).toBe(1);
    expect(contactsCount.c).toBe(1);
    expect(notesCount.c).toBe(1);

    migrated.close();
  });

  it('leaves foreign key enforcement re-enabled after the migration completes', () => {
    const db = openDb(dbPath);
    const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result[0]?.foreign_keys).toBe(1);

    expect(() =>
      db.prepare('INSERT INTO roles (company_id, url) VALUES (?, ?)').run(999, 'https://example.com/job'),
    ).toThrow();
    db.close();
  });

  it('accepts a NULL company_id on a role after migrating', () => {
    const db = openDb(dbPath);
    expect(() =>
      db.prepare('INSERT INTO roles (company_id, url) VALUES (NULL, ?)').run('https://example.com/jobs/unresolved'),
    ).not.toThrow();

    const role = db
      .prepare('SELECT company_id FROM roles WHERE url = ?')
      .get('https://example.com/jobs/unresolved') as { company_id: number | null };
    expect(role.company_id).toBeNull();
    db.close();
  });

  it('re-running runMigrations on an already-migrated database is a no-op (idempotent)', () => {
    const db = openDb(dbPath);
    expect(() => runMigrations(db)).not.toThrow();

    const rows = db.prepare('SELECT id FROM _migrations').all() as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual([
      '0001_init.sql',
      '0002_nullable_role_company.sql',
      '0003_operational_logs.sql',
    ]);
    db.close();
  });
});

describe('applyMigrationFile — foreign-keys-off violation handling', () => {
  it('a migration that would leave a dangling FK reference rolls back cleanly instead of being partially committed', () => {
    const db = openDb(dbPath);

    // Deliberately violates the roles -> role_status_history relationship:
    // with foreign_keys off during apply, this insert succeeds at exec
    // time, and PRAGMA foreign_key_check should catch it before commit.
    const violatingSql = [
      '-- migration-lock: foreign-keys-off',
      "INSERT INTO role_status_history (role_id, to_status) VALUES (999999, 'new');",
    ].join('\n');

    expect(() => applyMigrationFile(db, 'test_violation.sql', violatingSql)).toThrow(/dangling foreign key/);

    const recorded = db.prepare('SELECT id FROM _migrations WHERE id = ?').get('test_violation.sql');
    expect(recorded).toBeUndefined();

    const orphanRow = db.prepare('SELECT COUNT(*) as c FROM role_status_history WHERE role_id = 999999').get() as {
      c: number;
    };
    expect(orphanRow.c).toBe(0);

    const fk = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0]?.foreign_keys).toBe(1);

    db.close();
  });
});

describe('migration lock stale-holder recovery', () => {
  it('a lock file left by a dead process is taken over rather than deadlocking future migrations', () => {
    // Simulate a process that crashed mid-migration: a lock file recording
    // a pid that no longer exists.
    const lockPath = `${dbPath}.migrating.lock`;
    const deadPid = 999_999; // astronomically unlikely to be a real live pid
    expect(isProcessAlive(deadPid)).toBe(false);
    fs.writeFileSync(lockPath, String(deadPid));

    const start = Date.now();
    expect(() => openDb(dbPath)).not.toThrow();
    const elapsedMs = Date.now() - start;

    // Should recover near-instantly via stale-lock detection, not sit out
    // the full 10s timeout.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
