import type Database from 'better-sqlite3';
import { ACTIVE_ROLE_STATUSES, type RoleStatus } from '../../domain/role-status.js';
import { DuplicateError, NotFoundError } from '../errors.js';

export interface Role {
  id: number;
  company_id: number;
  url: string;
  title: string | null;
  description: string | null;
  status: RoleStatus;
  status_changed_at: string;
  reapply_after: string | null;
  salary_min: number | null;
  salary_max: number | null;
  equity: string | null;
  remote_eu: 'yes' | 'no' | 'unknown' | null;
  priority_score: number | null;
  closed_at: string | null;
  last_checked_at: string | null;
  last_enriched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoleStatusHistoryEntry {
  id: number;
  role_id: number;
  from_status: RoleStatus | null;
  to_status: RoleStatus;
  changed_at: string;
  context: string | null;
}

export interface CreateRoleOptions {
  companyId: number;
  url: string;
  force?: boolean;
}

export interface ListRolesOptions {
  status?: RoleStatus;
  companyId?: number;
  sort?: 'priority' | 'updated' | 'company';
}

/** Normalizes a URL for duplicate comparison: lowercased host, path with trailing slash stripped, query/hash ignored. */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function getRoleById(db: Database.Database, id: number): Role | undefined {
  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as Role | undefined;
}

function requireRole(db: Database.Database, id: number): Role {
  const role = getRoleById(db, id);
  if (!role) throw new NotFoundError(`Role #${id} not found`);
  return role;
}

export function createRole(db: Database.Database, options: CreateRoleOptions): Role {
  // The duplicate check (SELECT existing roles, compare, then INSERT) has no
  // DB-level constraint backing it up now that UNIQUE(company_id, url) is
  // gone — unlike companies.createCompany, which leans on a real UNIQUE
  // constraint. Wrapped in one BEGIN IMMEDIATE transaction so two processes
  // racing to add the same URL (e.g. the CLI and a discover job in the
  // daemon) serialize instead of both passing the check.
  const insertRole = db.transaction(() => {
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(options.companyId);
    if (!company) throw new NotFoundError(`Company #${options.companyId} not found`);

    if (!options.force) {
      const normalized = normalizeUrl(options.url);
      const existingRoles = db
        .prepare('SELECT id, url FROM roles WHERE company_id = ?')
        .all(options.companyId) as { id: number; url: string }[];
      const match = existingRoles.find((role) => normalizeUrl(role.url) === normalized);
      if (match) {
        throw new DuplicateError(
          `Role #${match.id} at this company already tracks a URL that looks the same (${match.url}). Use --force to add anyway.`,
        );
      }
    }

    const result = db.prepare('INSERT INTO roles (company_id, url) VALUES (?, ?)').run(
      options.companyId,
      options.url,
    );
    return result.lastInsertRowid as number;
  });

  const insertedId = insertRole.immediate();
  const role = getRoleById(db, insertedId);
  if (!role) throw new Error('Role vanished immediately after insert');
  return role;
}

export function listRoles(db: Database.Database, options: ListRolesOptions = {}): Role[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  } else {
    clauses.push(`status IN (${ACTIVE_ROLE_STATUSES.map(() => '?').join(', ')})`);
    params.push(...ACTIVE_ROLE_STATUSES);
  }

  if (options.companyId) {
    clauses.push('company_id = ?');
    params.push(options.companyId);
  }

  const orderBy =
    options.sort === 'priority'
      ? 'priority_score DESC'
      : options.sort === 'company'
        ? 'company_id ASC'
        : 'updated_at DESC';

  return db
    .prepare(`SELECT * FROM roles WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy}`)
    .all(...params) as Role[];
}

export function getStatusHistory(db: Database.Database, roleId: number): RoleStatusHistoryEntry[] {
  return db
    .prepare('SELECT * FROM role_status_history WHERE role_id = ? ORDER BY changed_at ASC, id ASC')
    .all(roleId) as RoleStatusHistoryEntry[];
}

function addOneMonthIso(from: Date): string {
  const date = new Date(from.getTime());
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

export function setStatus(
  db: Database.Database,
  id: number,
  status: RoleStatus,
  context?: string,
): Role {
  const role = requireRole(db, id);
  const reapplyAfter = status === 'denied' ? addOneMonthIso(new Date()) : role.reapply_after;

  const applyChange = db.transaction(() => {
    db.prepare(
      `UPDATE roles
       SET status = ?, status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reapply_after = ?
       WHERE id = ?`,
    ).run(status, reapplyAfter, id);
    db.prepare(
      'INSERT INTO role_status_history (role_id, from_status, to_status, context) VALUES (?, ?, ?, ?)',
    ).run(id, role.status, status, context ?? null);
  });
  applyChange();

  return requireRole(db, id);
}

export function setReapplyAfter(db: Database.Database, id: number, isoDate: string): Role {
  requireRole(db, id);
  db.prepare(
    "UPDATE roles SET reapply_after = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(isoDate, id);
  return requireRole(db, id);
}
