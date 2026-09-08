import type Database from 'better-sqlite3';
import { DuplicateError, NotFoundError } from '../errors.js';

export interface Company {
  id: number;
  url: string;
  name: string | null;
  description: string | null;
  preference_rating: number;
  connections: string | null;
  ipo_status: string | null;
  ai_proof_score: number | null;
  ai_proof_notes: string | null;
  wlb_score: number | null;
  wlb_notes: string | null;
  last_enriched_at: string | null;
  created_at: string;
  updated_at: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function createCompany(db: Database.Database, url: string): Company {
  let insertedId: number;
  try {
    const result = db.prepare('INSERT INTO companies (url) VALUES (?)').run(url);
    insertedId = result.lastInsertRowid as number;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new DuplicateError(`A company with url "${url}" is already tracked`);
    }
    throw error;
  }

  const company = getCompanyById(db, insertedId);
  if (!company) throw new Error('Company vanished immediately after insert');
  return company;
}

export function listCompanies(db: Database.Database): Company[] {
  return db.prepare('SELECT * FROM companies ORDER BY created_at DESC').all() as Company[];
}

export function getCompanyById(db: Database.Database, id: number): Company | undefined {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Company | undefined;
}

function requireCompany(db: Database.Database, id: number): Company {
  const company = getCompanyById(db, id);
  if (!company) throw new NotFoundError(`Company #${id} not found`);
  return company;
}

export function setPreferenceRating(db: Database.Database, id: number, rating: number): Company {
  requireCompany(db, id);
  db.prepare(
    "UPDATE companies SET preference_rating = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(rating, id);
  return requireCompany(db, id);
}

export function setConnections(db: Database.Database, id: number, note: string): Company {
  requireCompany(db, id);
  db.prepare(
    "UPDATE companies SET connections = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(note, id);
  return requireCompany(db, id);
}
