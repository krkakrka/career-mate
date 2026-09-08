import type Database from 'better-sqlite3';
import { normalizeUrl } from '../../lib/normalize-url.js';
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

export function createCompany(db: Database.Database, url: string, name?: string | null): Company {
  let insertedId: number;
  try {
    const result = db.prepare('INSERT INTO companies (url, name) VALUES (?, ?)').run(url, name ?? null);
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

/**
 * Loose match by normalized URL — used to find-before-create when a role's
 * fetched page reveals its company. Full-table-scan-and-compare-in-JS
 * rather than an indexed query (same tradeoff findDuplicateRole in
 * roles.ts makes for role URLs) — deliberately deferred rather than adding
 * a normalized_url column + index: this is a personal tool tracking tens
 * to low hundreds of companies, not a scale where this matters yet, and
 * schema surgery carries real risk (see migration 0002's commit message).
 * Worth revisiting if the companies table ever gets large.
 */
export function findCompanyByUrl(db: Database.Database, url: string): Company | undefined {
  const normalized = normalizeUrl(url);
  const companies = db.prepare('SELECT * FROM companies').all() as Company[];
  return companies.find((company) => normalizeUrl(company.url) === normalized);
}

export interface FindOrCreateResult {
  company: Company;
  created: boolean;
}

/**
 * Atomic find-or-create by URL: the find and the (conditional) create
 * happen in one BEGIN IMMEDIATE transaction, so two enrichment jobs
 * resolving the same not-yet-tracked company at once (possible since
 * `cm worker drain` can run alongside the daemon, as separate processes)
 * can't both pass the find as "not found" and both insert.
 */
export function findOrCreateCompanyByUrl(
  db: Database.Database,
  url: string,
  name?: string | null,
): FindOrCreateResult {
  const run = db.transaction(() => {
    const existing = findCompanyByUrl(db, url);
    if (existing) return { id: existing.id, created: false };

    const result = db.prepare('INSERT INTO companies (url, name) VALUES (?, ?)').run(url, name ?? null);
    return { id: result.lastInsertRowid as number, created: true };
  });

  const { id, created } = run.immediate();
  const company = getCompanyById(db, id);
  if (!company) throw new Error('Company vanished immediately after find-or-create');
  return { company, created };
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

export interface UpdateCompanyStructuralFieldsParams {
  name?: string | null;
  description?: string | null;
}

/** Applies structural-fetch results (name/description) and stamps last_enriched_at. */
export function updateStructuralFields(
  db: Database.Database,
  id: number,
  fields: UpdateCompanyStructuralFieldsParams,
): Company {
  requireCompany(db, id);
  db.prepare(
    `UPDATE companies
     SET name = COALESCE(?, name), description = COALESCE(?, description),
         last_enriched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(fields.name ?? null, fields.description ?? null, id);
  return requireCompany(db, id);
}
