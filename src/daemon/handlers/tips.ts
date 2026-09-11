import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Company } from '../../db/repositories/companies.js';
import { getCompanyById } from '../../db/repositories/companies.js';
import { recordEvent } from '../../db/repositories/events.js';
import type { JobRecord } from '../../db/repositories/jobs.js';
import type { Role } from '../../db/repositories/roles.js';
import { getRoleById } from '../../db/repositories/roles.js';
import {
  createCompanyTips,
  createRoleTips,
  getFreshCompanyTips,
  type TipsRecord,
  type TipsSource,
} from '../../db/repositories/tips.js';
import { contextKey, recipeVersion } from '../../derive/keys.js';
import { recordDerivation } from '../../derive/record.js';
import { runExtraction } from '../../enrichment/claude-extract.js';

const tipsScript = fileURLToPath(new URL('../../enrichment/scripts/research-tips.sh', import.meta.url));

export type TipsJobPayload = { kind: 'role-tips'; roleId: number };

interface TipsExtraction {
  content?: string | null;
  sources?: unknown;
}

/**
 * Company-level tips are reused across every role at that company within
 * this window instead of being re-researched from scratch each time.
 * Could move into settings.json alongside recruiter_nudge_days/stale_days
 * once that config exists for other purposes (a later step) — not worth
 * building that shared infrastructure just for this one constant yet.
 */
export const COMPANY_TIPS_FRESHNESS_DAYS = 30;

export async function handleTipsJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as TipsJobPayload;
  if (payload.kind !== 'role-tips') {
    throw new Error(`Unknown tips job payload: ${job.payload}`);
  }
  await handleRoleTips(db, payload.roleId, job.id);
}

function normalizeSources(value: unknown): TipsSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is TipsSource =>
      typeof item === 'object' && item !== null && typeof (item as TipsSource).url === 'string',
  );
}

/**
 * Tips deliberately do NOT get a `skipIfFresh` gate on top of their own
 * 30-day company-level cache (`findFreshCompanyTips`). Two freshness
 * policies over one value is a way to be confusing, not careful — and
 * `cm tips` is an explicit, blocking request for research, where the
 * existing cache is the intended answer to "don't redo this". The
 * derivation row is recorded for bookkeeping, so `cm status` can report
 * what tips actually cost.
 */
async function researchCompanyTips(db: Database.Database, company: Company, jobId: number): Promise<TipsRecord> {
  const context = JSON.stringify({ name: company.name, url: company.url, description: company.description });
  const { data, usage } = await runExtraction(tipsScript, ['company'], context);
  const extraction = data as TipsExtraction;
  recordDerivation(db, {
    entityType: 'company',
    entityId: company.id,
    kind: 'tips_company',
    key: { sourceKey: contextKey(context), recipeVersion: recipeVersion(tipsScript) },
    usage,
    jobId,
  });
  const sources = normalizeSources(extraction.sources);
  const record = createCompanyTips(db, company.id, extraction.content ?? '(no tips found)', sources);

  recordEvent(db, {
    entityType: 'company',
    entityId: company.id,
    type: 'company.tips_completed',
    context: { sourceCount: sources.length },
  });
  if (sources.length === 0) {
    recordEvent(db, {
      entityType: 'company',
      entityId: company.id,
      type: 'company.tips_no_sources_cited',
      context: {},
    });
  }

  return record;
}

async function researchRoleTips(
  db: Database.Database,
  role: Role,
  companyTips: TipsRecord,
  jobId: number,
): Promise<TipsRecord> {
  const context = JSON.stringify({
    companyTips: companyTips.content,
    roleTitle: role.title,
    roleDescription: role.description,
    roleUrl: role.url,
  });
  const { data, usage } = await runExtraction(tipsScript, ['role'], context);
  const extraction = data as TipsExtraction;
  recordDerivation(db, {
    entityType: 'role',
    entityId: role.id,
    kind: 'tips_role',
    key: { sourceKey: contextKey(context), recipeVersion: recipeVersion(tipsScript) },
    usage,
    jobId,
  });
  const sources = normalizeSources(extraction.sources);
  const record = createRoleTips(db, role.id, extraction.content ?? '(no role-specific tips found)', sources);

  recordEvent(db, {
    entityType: 'role',
    entityId: role.id,
    type: 'role.tips_completed',
    context: { sourceCount: sources.length },
  });
  if (sources.length === 0) {
    recordEvent(db, { entityType: 'role', entityId: role.id, type: 'role.tips_no_sources_cited', context: {} });
  }

  return record;
}

async function handleRoleTips(db: Database.Database, roleId: number, jobId: number): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);
  if (role.company_id == null) {
    throw new Error(`Role #${roleId} has no resolved company yet — can't research tips without knowing the company`);
  }

  const company = getCompanyById(db, role.company_id);
  if (!company) throw new Error(`Company #${role.company_id} not found`);

  const companyTips =
    getFreshCompanyTips(db, company.id, COMPANY_TIPS_FRESHNESS_DAYS) ??
    (await researchCompanyTips(db, company, jobId));

  await researchRoleTips(db, role, companyTips, jobId);
}
