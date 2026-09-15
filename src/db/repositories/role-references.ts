import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { NotFoundError } from '../errors.js';
import { resolveReferencePath } from '../../references/store.js';

/** The kinds the schema allows — `0001_init.sql` enforces the same list with a CHECK. */
export const REFERENCE_TYPES = ['cv', 'application_answers', 'cover_letter', 'other'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

export interface RoleReference {
  id: number;
  role_id: number;
  type: ReferenceType;
  /** career-mate's own copy, relative to the data dir — never the file you pointed at. Resolve with `resolveReferencePath`. */
  file_path: string;
  notes: string | null;
  created_at: string;
}

export function createRoleReference(
  db: Database.Database,
  params: { roleId: number; type: ReferenceType; filePath: string; notes?: string | null },
): RoleReference {
  const result = db
    .prepare('INSERT INTO role_references (role_id, type, file_path, notes) VALUES (?, ?, ?, ?)')
    .run(params.roleId, params.type, params.filePath, params.notes ?? null);
  return db.prepare('SELECT * FROM role_references WHERE id = ?').get(result.lastInsertRowid) as RoleReference;
}

export function listRoleReferences(db: Database.Database, roleId: number): RoleReference[] {
  return db
    .prepare('SELECT * FROM role_references WHERE role_id = ? ORDER BY created_at DESC, id DESC')
    .all(roleId) as RoleReference[];
}

export function getRoleReference(db: Database.Database, id: number): RoleReference | undefined {
  return db.prepare('SELECT * FROM role_references WHERE id = ?').get(id) as RoleReference | undefined;
}

/**
 * Removes the row and the copy it points at.
 *
 * The file goes because it is *our* copy, made by `storeReferenceFile` and
 * living only under `.data/files/`; the original you attached was never
 * touched. Leaving it would accumulate orphans nothing can name.
 *
 * The row is deleted first and the file after: a failed unlink then leaves
 * a file nothing references, which `.data` can survive, where the reverse
 * leaves a row pointing at nothing — and `cm roles show` would offer you a
 * path that is not there.
 */
export function deleteRoleReference(db: Database.Database, id: number): { reference: RoleReference; fileRemoved: boolean } {
  const reference = getRoleReference(db, id);
  if (!reference) throw new NotFoundError(`No reference #${id}`);

  db.prepare('DELETE FROM role_references WHERE id = ?').run(id);

  let fileRemoved = true;
  try {
    fs.rmSync(resolveReferencePath(reference.file_path), { force: true });
  } catch {
    // A read-only or unmounted `.data` volume. Reported rather than
    // swallowed: this command's whole framing is about what it did and did
    // not delete, so claiming the copy is gone when it is not would be the
    // one lie that matters here.
    fileRemoved = false;
  }
  return { reference, fileRemoved };
}
