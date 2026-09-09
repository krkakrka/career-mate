import type Database from 'better-sqlite3';
import { ACTIVE_ROLE_STATUSES, type RoleStatus } from '../../domain/role-status.js';
import { normalizeUrl } from '../../lib/normalize-url.js';
import { DuplicateError, NotFoundError } from '../errors.js';

export interface Role {
  id: number;
  /** Null until the structural-fetch enrichment job resolves it, for a role added without --company. */
  company_id: number | null;
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
  /** Omit to create the role with its company unresolved — the structural-fetch job attaches one once it fetches the page. */
  companyId?: number | null;
  url: string;
  force?: boolean;
}

export interface ListRolesOptions {
  status?: RoleStatus;
  companyId?: number;
  sort?: 'priority' | 'updated' | 'company';
}

export function getRoleById(db: Database.Database, id: number): Role | undefined {
  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as Role | undefined;
}

/** Every role id at a company, regardless of status — used by priority-score recompute cascades, not general listing (which defaults to active statuses only). */
export function listRoleIdsForCompany(db: Database.Database, companyId: number): number[] {
  return (db.prepare('SELECT id FROM roles WHERE company_id = ?').all(companyId) as { id: number }[]).map(
    (row) => row.id,
  );
}

/** Active-status roles not yet known closed — what `cm refresh` checks. Terminal-status roles (success/denied/skip) don't need closure checking. */
export function listRoleIdsNeedingClosureCheck(db: Database.Database): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM roles WHERE closed_at IS NULL AND status IN (${ACTIVE_ROLE_STATUSES.map(() => '?').join(', ')})`,
      )
      .all(...ACTIVE_ROLE_STATUSES) as { id: number }[]
  ).map((row) => row.id);
}

function requireRole(db: Database.Database, id: number): Role {
  const role = getRoleById(db, id);
  if (!role) throw new NotFoundError(`Role #${id} not found`);
  return role;
}

/**
 * Duplicate scope: when the company is already known, only roles at that
 * company count as duplicates (the same URL under two different companies
 * legitimately happens — mirrored postings, recruiting agencies). When the
 * company is still unresolved, there's no company to scope by, so the
 * check is global by normalized URL instead — the URL is the only stable
 * identifier available yet.
 */
function findDuplicateRole(
  db: Database.Database,
  companyId: number | null | undefined,
  url: string,
): { id: number; url: string } | undefined {
  const normalized = normalizeUrl(url);
  const rows = (
    companyId != null
      ? db.prepare('SELECT id, url FROM roles WHERE company_id = ?').all(companyId)
      : db.prepare('SELECT id, url FROM roles').all()
  ) as { id: number; url: string }[];
  return rows.find((role) => normalizeUrl(role.url) === normalized);
}

export function createRole(db: Database.Database, options: CreateRoleOptions): Role {
  // The duplicate check (SELECT existing roles, compare, then INSERT) has no
  // DB-level constraint backing it up now that UNIQUE(company_id, url) is
  // gone — unlike companies.createCompany, which leans on a real UNIQUE
  // constraint. Wrapped in one BEGIN IMMEDIATE transaction so two processes
  // racing to add the same URL (e.g. the CLI and a discover job in the
  // daemon) serialize instead of both passing the check.
  const insertRole = db.transaction(() => {
    if (options.companyId != null) {
      const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(options.companyId);
      if (!company) throw new NotFoundError(`Company #${options.companyId} not found`);
    }

    if (!options.force) {
      const match = findDuplicateRole(db, options.companyId, options.url);
      if (match) {
        throw new DuplicateError(
          `Role #${match.id} already tracks a URL that looks the same (${match.url}). Use --force to add anyway.`,
        );
      }
    }

    const result = db.prepare('INSERT INTO roles (company_id, url) VALUES (?, ?)').run(
      options.companyId ?? null,
      options.url,
    );
    return result.lastInsertRowid as number;
  });

  const insertedId = insertRole.immediate();
  const role = getRoleById(db, insertedId);
  if (!role) throw new Error('Role vanished immediately after insert');
  return role;
}

/**
 * Attaches a resolved company to a role, but only if it's still unresolved
 * — an atomic conditional UPDATE, not read-then-write. Structural fetch is
 * a multi-second async operation (fetch + claude -p), so two enrichment
 * runs for the same role (e.g. the original `add`-triggered job and a
 * manual `rerun-enrichment` overlapping it — plausible since `cm worker
 * drain` can run alongside the daemon as a separate process) can both
 * reach this point; without the WHERE guard, whichever finishes last wins
 * silently, possibly attaching a different company than the one already
 * settled on. Returns whether *this* call was the one that attached it.
 */
export function attachCompanyIfUnresolved(db: Database.Database, roleId: number, companyId: number): boolean {
  requireRole(db, roleId);
  const result = db
    .prepare(
      "UPDATE roles SET company_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND company_id IS NULL",
    )
    .run(companyId, roleId);
  return result.changes > 0;
}

export interface UpdateRoleStructuralFieldsParams {
  title?: string | null;
  description?: string | null;
}

/** Applies structural-fetch results (title/description) and stamps last_enriched_at. */
export function updateStructuralFields(
  db: Database.Database,
  roleId: number,
  fields: UpdateRoleStructuralFieldsParams,
): Role {
  requireRole(db, roleId);
  db.prepare(
    `UPDATE roles
     SET title = COALESCE(?, title), description = COALESCE(?, description),
         last_enriched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(fields.title ?? null, fields.description ?? null, roleId);
  return requireRole(db, roleId);
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

export interface UpdateRoleResearchFieldsParams {
  salaryMin?: number | null;
  salaryMax?: number | null;
  equity?: string | null;
  remoteEu?: 'yes' | 'no' | 'unknown' | null;
}

/** Applies full-enrichment research results (comp/equity/remote-EU) and stamps last_enriched_at. */
export function updateResearchFields(
  db: Database.Database,
  roleId: number,
  fields: UpdateRoleResearchFieldsParams,
): Role {
  requireRole(db, roleId);
  db.prepare(
    `UPDATE roles
     SET salary_min = COALESCE(?, salary_min), salary_max = COALESCE(?, salary_max),
         equity = COALESCE(?, equity), remote_eu = COALESCE(?, remote_eu),
         last_enriched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(fields.salaryMin ?? null, fields.salaryMax ?? null, fields.equity ?? null, fields.remoteEu ?? null, roleId);
  return requireRole(db, roleId);
}

/** Stamps last_checked_at — call after every refresh attempt, regardless of outcome, so "when did we last check" is always accurate. */
export function markLastChecked(db: Database.Database, roleId: number): Role {
  requireRole(db, roleId);
  db.prepare(
    "UPDATE roles SET last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(roleId);
  return requireRole(db, roleId);
}

export interface MarkClosedResult {
  role: Role;
  /** Whether *this* call was the one that closed it — mirrors attachCompanyIfUnresolved's race-guard pattern. Two overlapping closure checks for the same role (e.g. two `cm refresh` runs, or `cm worker drain` alongside the live daemon) can both read `closed_at IS NULL` before either writes; only the call whose UPDATE actually matched should record the closure event/notification, or a single real closure double-fires both. */
  wasNewlyClosed: boolean;
}

/** Idempotent: only sets closed_at if it isn't already set, so re-checking an already-closed role doesn't overwrite when it was first detected as closed. */
export function markClosed(db: Database.Database, roleId: number): MarkClosedResult {
  requireRole(db, roleId);
  const result = db
    .prepare(
      "UPDATE roles SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND closed_at IS NULL",
    )
    .run(roleId);
  return { role: requireRole(db, roleId), wasNewlyClosed: result.changes > 0 };
}
