import type Database from 'better-sqlite3';

export interface RecruiterContact {
  id: number;
  role_id: number;
  recruiter_name: string;
  contacted_at: string;
  channel: string | null;
  link: string | null;
  notes: string | null;
  responded_at: string | null;
}

export interface CreateRecruiterContactParams {
  roleId: number;
  recruiterName: string;
  channel?: string;
  link?: string;
  notes?: string;
  contactedAt?: string;
}

export function createRecruiterContact(db: Database.Database, params: CreateRecruiterContactParams): RecruiterContact {
  const result = db.prepare(
    `INSERT INTO recruiter_contacts
      (role_id, recruiter_name, contacted_at, channel, link, notes)
     VALUES (?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?)`,
  ).run(params.roleId, params.recruiterName, params.contactedAt ?? null, params.channel ?? null, params.link ?? null, params.notes ?? null);
  return getRecruiterContactById(db, result.lastInsertRowid as number)!;
}

export function getRecruiterContactById(db: Database.Database, id: number): RecruiterContact | undefined {
  return db.prepare('SELECT * FROM recruiter_contacts WHERE id = ?').get(id) as RecruiterContact | undefined;
}

export interface ListRecruiterContactsOptions {
  roleId?: number;
  overdueDays?: number;
}

export function listRecruiterContacts(
  db: Database.Database,
  options: ListRecruiterContactsOptions = {},
): RecruiterContact[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.roleId != null) {
    clauses.push('role_id = ?');
    params.push(options.roleId);
  }
  if (options.overdueDays != null) {
    const cutoff = new Date(Date.now() - options.overdueDays * 24 * 60 * 60 * 1000).toISOString();
    clauses.push('responded_at IS NULL AND contacted_at < ?');
    params.push(cutoff);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = options.overdueDays != null ? 'contacted_at ASC, id ASC' : 'contacted_at DESC, id DESC';

  return db.prepare(`SELECT * FROM recruiter_contacts ${where} ORDER BY ${orderBy}`).all(...params) as RecruiterContact[];
}

/**
 * Idempotent: only sets responded_at if it isn't already set. Without the
 * WHERE guard, re-running `cm recruiters respond <id>` on an
 * already-responded contact (e.g. by mistake, or a retried command) would
 * silently overwrite the true original response timestamp with "now" —
 * first response wins, later calls are a no-op on an already-set row.
 */
export function markRecruiterContactResponded(db: Database.Database, id: number): RecruiterContact | undefined {
  db.prepare(
    "UPDATE recruiter_contacts SET responded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND responded_at IS NULL",
  ).run(id);
  return getRecruiterContactById(db, id);
}
