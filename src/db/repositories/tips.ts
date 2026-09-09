import type Database from 'better-sqlite3';

export interface TipsSource {
  url: string;
  title: string;
}

export interface TipsRecord {
  id: number;
  scope: 'company' | 'role';
  company_id: number | null;
  role_id: number | null;
  content: string;
  sources: string; // JSON-encoded TipsSource[]
  generated_at: string;
}

function getById(db: Database.Database, id: number): TipsRecord {
  const row = db.prepare('SELECT * FROM tips WHERE id = ?').get(id) as TipsRecord | undefined;
  if (!row) throw new Error('Tips record vanished immediately after insert');
  return row;
}

/** Most recent company-level tips generated within the last `maxAgeDays` — undefined if none exist or the newest is stale. */
export function getFreshCompanyTips(
  db: Database.Database,
  companyId: number,
  maxAgeDays: number,
): TipsRecord | undefined {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM tips WHERE scope = 'company' AND company_id = ? AND generated_at >= ? ORDER BY generated_at DESC LIMIT 1",
    )
    .get(companyId, cutoff) as TipsRecord | undefined;
}

export function getLatestRoleTips(db: Database.Database, roleId: number): TipsRecord | undefined {
  return db
    .prepare("SELECT * FROM tips WHERE scope = 'role' AND role_id = ? ORDER BY generated_at DESC LIMIT 1")
    .get(roleId) as TipsRecord | undefined;
}

export function createCompanyTips(
  db: Database.Database,
  companyId: number,
  content: string,
  sources: TipsSource[],
): TipsRecord {
  const result = db
    .prepare("INSERT INTO tips (scope, company_id, content, sources) VALUES ('company', ?, ?, ?)")
    .run(companyId, content, JSON.stringify(sources));
  return getById(db, result.lastInsertRowid as number);
}

export function createRoleTips(
  db: Database.Database,
  roleId: number,
  content: string,
  sources: TipsSource[],
): TipsRecord {
  const result = db
    .prepare("INSERT INTO tips (scope, role_id, content, sources) VALUES ('role', ?, ?, ?)")
    .run(roleId, content, JSON.stringify(sources));
  return getById(db, result.lastInsertRowid as number);
}
