import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { recordEvent } from '../../db/repositories/events.js';
import {
  findOrCreateCompanyByUrl,
  getCompanyById,
  updateStructuralFields as updateCompanyStructuralFields,
} from '../../db/repositories/companies.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import {
  attachCompanyIfUnresolved,
  getRoleById,
  updateStructuralFields as updateRoleStructuralFields,
} from '../../db/repositories/roles.js';
import { runExtraction } from '../../enrichment/claude-extract.js';
import { fetchPageContent } from '../../enrichment/fetch-page.js';
import { isHttpUrl } from '../../lib/is-http-url.js';

const structuralScript = fileURLToPath(new URL('../../enrichment/scripts/extract-structural.sh', import.meta.url));

export type EnrichmentJobPayload =
  | { kind: 'company-structural'; companyId: number }
  | { kind: 'role-structural'; roleId: number };

interface CompanyExtraction {
  name?: string | null;
  description?: string | null;
}

interface RoleExtraction {
  title?: string | null;
  description?: string | null;
  companyName?: string | null;
  companyUrl?: string | null;
}

export async function handleEnrichmentJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as EnrichmentJobPayload;

  if (payload.kind === 'company-structural') {
    await handleCompanyStructural(db, payload.companyId);
  } else if (payload.kind === 'role-structural') {
    await handleRoleStructural(db, payload.roleId);
  } else {
    throw new Error(`Unknown enrichment job payload: ${job.payload}`);
  }
}

async function handleCompanyStructural(db: Database.Database, companyId: number): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const html = await fetchPageContent(company.url);
  const extraction = (await runExtraction(structuralScript, ['company'], html)) as CompanyExtraction;

  updateCompanyStructuralFields(db, companyId, {
    name: extraction.name ?? null,
    description: extraction.description ?? null,
  });

  recordEvent(db, {
    entityType: 'company',
    entityId: companyId,
    type: 'company.structural_fetch_completed',
    context: { name: extraction.name ?? null },
  });
}

async function handleRoleStructural(db: Database.Database, roleId: number): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);

  // fetch + runExtraction below take several seconds — don't trust
  // role.company_id captured before them by the time we're deciding
  // whether to resolve a company; re-read fresh right before that check.
  const html = await fetchPageContent(role.url);
  const extraction = (await runExtraction(structuralScript, ['role'], html)) as RoleExtraction;

  updateRoleStructuralFields(db, roleId, {
    title: extraction.title ?? null,
    description: extraction.description ?? null,
  });

  recordEvent(db, {
    entityType: 'role',
    entityId: roleId,
    type: 'role.structural_fetch_completed',
    context: { title: extraction.title ?? null },
  });

  const currentRole = getRoleById(db, roleId);
  if (currentRole?.company_id == null) {
    resolveRoleCompany(db, roleId, extraction);
  }
}

/** Exported for direct testing of the resolution logic (valid/invalid/missing companyUrl, race guard) without needing a real claude -p call. */
export function resolveRoleCompany(db: Database.Database, roleId: number, extraction: RoleExtraction): void {
  const companyUrl = extraction.companyUrl?.trim();
  const companyName = extraction.companyName?.trim();

  if (!companyUrl || !isHttpUrl(companyUrl)) {
    recordEvent(db, {
      entityType: 'role',
      entityId: roleId,
      type: 'role.company_unresolved',
      context: {
        reason: companyUrl ? 'extracted companyUrl was not a valid http(s) URL' : 'no companyUrl extracted from the role page',
        companyName: companyName ?? null,
        companyUrl: companyUrl ?? null,
      },
    });
    return;
  }

  const { company, created } = findOrCreateCompanyByUrl(db, companyUrl, companyName ?? null);
  const attached = attachCompanyIfUnresolved(db, roleId, company.id);

  if (!attached) {
    // A concurrent enrichment run for the same role (e.g. rerun-enrichment
    // overlapping the original add-triggered job) already resolved it
    // first — this run's find-or-create may have left an unreferenced
    // company behind if it created one, but it's a harmless, still-valid
    // company record, not corruption.
    recordEvent(db, {
      entityType: 'role',
      entityId: roleId,
      type: 'role.company_resolution_lost_race',
      context: { companyId: company.id },
    });
    return;
  }

  recordEvent(db, {
    entityType: 'role',
    entityId: roleId,
    type: 'role.company_resolved',
    context: { companyId: company.id, matched: created ? 'created' : 'existing' },
  });

  if (created) {
    // The role page only told us the company's name — enqueue a proper
    // structural fetch against its own homepage for a real description.
    enqueueJob(db, { topic: 'enrichment', payload: { kind: 'company-structural', companyId: company.id } });
  }
}
