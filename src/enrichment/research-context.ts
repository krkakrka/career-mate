import type Database from 'better-sqlite3';
import { getCompanyById, type Company } from '../db/repositories/companies.js';
import type { Role } from '../db/repositories/roles.js';

/**
 * The exact JSON handed to `research-web.sh` for each research kind.
 *
 * These live here rather than inline in the handlers because two callers
 * need the identical string: the handler, which pipes it to the model, and
 * the staleness check, which hashes it to decide whether the stored value
 * still corresponds to it. If the two ever built the context differently —
 * a reordered key is enough, since this is hashed as text — every read
 * would report the value stale and enqueue a recompute that changes
 * nothing, forever.
 */
export function buildRoleResearchContext(db: Database.Database, role: Role): string {
  const company = role.company_id != null ? getCompanyById(db, role.company_id) : undefined;
  return JSON.stringify({
    title: role.title,
    description: role.description,
    companyName: company?.name ?? null,
    roleUrl: role.url,
  });
}

export function buildCompanyResearchContext(company: Company): string {
  return JSON.stringify({ name: company.name, url: company.url, description: company.description });
}
