import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './client.js';
import { runMigrations } from './migrate.js';

const EXPECTED_TABLES = [
  'companies',
  'roles',
  'role_status_history',
  'role_references',
  'tips',
  'recruiter_contacts',
  'interview_notes',
  'events',
  'notifications',
  'jobs',
];

let tempDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-db-test-'));
  dbPath = path.join(tempDir, 'career-mate.db');
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function tableNames(database: Database.Database): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function columnNames(database: Database.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

describe('openDb', () => {
  it('creates every expected table on a fresh database', () => {
    const names = tableNames(db);
    for (const table of EXPECTED_TABLES) {
      expect(names).toContain(table);
    }
  });

  it('enables WAL mode', () => {
    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0]?.journal_mode).toBe('wal');
  });

  it('enables foreign key enforcement', () => {
    const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result[0]?.foreign_keys).toBe(1);
  });

  it('key tables have the columns the rest of the app depends on', () => {
    expect(columnNames(db, 'companies')).toEqual(
      expect.arrayContaining(['id', 'url', 'name', 'preference_rating', 'connections']),
    );
    expect(columnNames(db, 'roles')).toEqual(
      expect.arrayContaining(['id', 'company_id', 'status', 'priority_score', 'reapply_after']),
    );
    expect(columnNames(db, 'jobs')).toEqual(
      expect.arrayContaining(['id', 'topic', 'status', 'priority', 'available_at', 'attempts']),
    );
  });
});

describe('runMigrations', () => {
  it('is idempotent — reapplying does not error and does not duplicate migration records', () => {
    runMigrations(db);
    runMigrations(db);

    const rows = db.prepare('SELECT id FROM _migrations').all() as { id: string }[];
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('0001_init.sql');
  });

  it('reopening the same database file does not recreate tables', () => {
    db.close();
    // Reopening an existing file should skip already-applied migrations
    // rather than erroring on "table already exists".
    expect(() => openDb(dbPath)).not.toThrow();
  });
});

describe('foreign key enforcement in practice', () => {
  it('rejects a role referencing a nonexistent company', () => {
    expect(() =>
      db.prepare('INSERT INTO roles (company_id, url) VALUES (?, ?)').run(999, 'https://example.com/job'),
    ).toThrow();
  });

  it('cascades company deletion to its roles', () => {
    const companyId = db
      .prepare('INSERT INTO companies (url) VALUES (?)')
      .run('https://example.com')
      .lastInsertRowid as number;
    db.prepare('INSERT INTO roles (company_id, url) VALUES (?, ?)').run(
      companyId,
      'https://example.com/job',
    );

    db.prepare('DELETE FROM companies WHERE id = ?').run(companyId);

    const remainingRoles = db.prepare('SELECT COUNT(*) as count FROM roles').get() as {
      count: number;
    };
    expect(remainingRoles.count).toBe(0);
  });
});
