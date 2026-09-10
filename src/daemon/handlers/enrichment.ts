import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { fetchAuthenticatedPage } from '../../browser/profile.js';
import {
  findOrCreateCompanyByUrl,
  getCompanyById,
  updateResearchFields as updateCompanyResearchFields,
  updateStructuralFields as updateCompanyStructuralFields,
} from '../../db/repositories/companies.js';
import { recordEvent } from '../../db/repositories/events.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import {
  attachCompanyIfUnresolved,
  getRoleById,
  updateResearchFields as updateRoleResearchFields,
  updateStructuralFields as updateRoleStructuralFields,
} from '../../db/repositories/roles.js';
import { runExtraction } from '../../enrichment/claude-extract.js';
import { getSourceRecipe } from '../../enrichment/sources.js';
import { isHttpUrl } from '../../lib/is-http-url.js';
import { readSnapshotText, snapshotPage } from '../../pages/store.js';
import { recomputePriorityForCompanyRoles, recomputePriorityForRole } from '../../scoring/priority.js';

const structuralScript = fileURLToPath(new URL('../../enrichment/scripts/extract-structural.sh', import.meta.url));
const researchWebScript = fileURLToPath(new URL('../../enrichment/scripts/research-web.sh', import.meta.url));
const extractWlbScript = fileURLToPath(new URL('../../enrichment/scripts/extract-wlb.sh', import.meta.url));

export type EnrichmentJobPayload =
  // `force` on the two structural kinds means only "take a new snapshot,
  // ignoring page_refresh_days" — it never overwrites derived data. It is
  // what `rerun-enrichment` sets, so that command keeps meaning "go look
  // at the page again" rather than re-extracting the cached text.
  | { kind: 'company-structural'; companyId: number; force?: boolean }
  | { kind: 'role-structural'; roleId: number; force?: boolean }
  | { kind: 'role-research'; roleId: number }
  | { kind: 'company-research'; companyId: number }
  | { kind: 'company-wlb'; companyId: number };

interface CompanyStructuralExtraction {
  name?: string | null;
  description?: string | null;
}

interface RoleStructuralExtraction {
  title?: string | null;
  description?: string | null;
  companyName?: string | null;
  companyUrl?: string | null;
}

interface RoleResearchExtraction {
  salaryMin?: number | null;
  salaryMax?: number | null;
  equity?: string | null;
  remoteEu?: string | null;
}

interface CompanyResearchExtraction {
  ipoStatus?: string | null;
  aiProofScore?: number | null;
  aiProofNotes?: string | null;
}

interface WlbExtraction {
  wlbScore?: number | null;
  wlbNotes?: string | null;
}

export async function handleEnrichmentJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as EnrichmentJobPayload;

  switch (payload.kind) {
    case 'company-structural':
      await handleCompanyStructural(db, payload.companyId, payload.force ?? false);
      return;
    case 'role-structural':
      await handleRoleStructural(db, payload.roleId, payload.force ?? false);
      return;
    case 'role-research':
      await handleRoleResearch(db, payload.roleId);
      return;
    case 'company-research':
      await handleCompanyResearch(db, payload.companyId);
      return;
    case 'company-wlb':
      await handleCompanyWlb(db, payload.companyId);
      return;
    default:
      throw new Error(`Unknown enrichment job payload: ${job.payload}`);
  }
}

async function handleCompanyStructural(db: Database.Database, companyId: number, force: boolean): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const snapshot = await snapshotPage(db, company.url, { kind: 'company', force });
  const extraction = (await runExtraction(
    structuralScript,
    ['company'],
    readSnapshotText(snapshot),
  )) as CompanyStructuralExtraction;

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

  recomputePriorityForCompanyRoles(db, companyId);

  // Structural fetch is the fast/cheap pass; full research follows
  // automatically, per the architecture (fast structural now, deeper
  // research as a separate job after).
  enqueueJob(db, { topic: 'enrichment', payload: { kind: 'company-research', companyId } });
  enqueueJob(db, { topic: 'enrichment', payload: { kind: 'company-wlb', companyId } });
}

async function handleRoleStructural(db: Database.Database, roleId: number, force: boolean): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);

  // snapshotPage + runExtraction below take several seconds — don't trust
  // role.company_id captured before them by the time we're deciding
  // whether to resolve a company; re-read fresh right before that check.
  const snapshot = await snapshotPage(db, role.url, { kind: 'role', force });
  const extraction = (await runExtraction(
    structuralScript,
    ['role'],
    readSnapshotText(snapshot),
  )) as RoleStructuralExtraction;

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

  recomputePriorityForRole(db, roleId);
  enqueueJob(db, { topic: 'enrichment', payload: { kind: 'role-research', roleId } });
}

/** Exported for direct testing of the resolution logic (valid/invalid/missing companyUrl, race guard) without needing a real claude -p call. */
export function resolveRoleCompany(db: Database.Database, roleId: number, extraction: RoleStructuralExtraction): void {
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
    // structural fetch against its own homepage for a real description
    // (which itself chains into company-research/company-wlb on completion).
    enqueueJob(db, { topic: 'enrichment', payload: { kind: 'company-structural', companyId: company.id } });
  }
}

function normalizeRemoteEu(value: string | null | undefined): 'yes' | 'no' | 'unknown' | null {
  return value === 'yes' || value === 'no' || value === 'unknown' ? value : null;
}

// role_research and company_research always use open web search — they
// intentionally never check recipe.urlTemplate. That's the reverse of
// handleCompanyWlb below, where a template is *required*: WLB's source is
// login-gated, and claude -p's web search can't see past a login wall at
// all, so there's no search fallback to reach for. Comp/IPO/AI-proof have
// no such blocker; a templated-fetch path for them (mirroring structural
// fetch's pattern) is a reasonable future addition once a real template
// exists, but building it against a hypothetical is premature — nothing
// supplies one yet.
async function handleRoleResearch(db: Database.Database, roleId: number): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);

  const company = role.company_id != null ? getCompanyById(db, role.company_id) : undefined;
  const recipe = getSourceRecipe('role_research');
  const context = JSON.stringify({
    title: role.title,
    description: role.description,
    companyName: company?.name ?? null,
    roleUrl: role.url,
  });

  const extraction = (await runExtraction(
    researchWebScript,
    ['role', recipe.instructions],
    context,
  )) as RoleResearchExtraction;

  const salaryMin = typeof extraction.salaryMin === 'number' ? extraction.salaryMin : null;
  const salaryMax = typeof extraction.salaryMax === 'number' ? extraction.salaryMax : null;

  updateRoleResearchFields(db, roleId, {
    salaryMin,
    salaryMax,
    equity: extraction.equity ?? null,
    remoteEu: normalizeRemoteEu(extraction.remoteEu),
  });

  recordEvent(db, {
    entityType: 'role',
    entityId: roleId,
    type: 'role.research_completed',
    context: { salaryMin, salaryMax, remoteEu: normalizeRemoteEu(extraction.remoteEu) },
  });

  recomputePriorityForRole(db, roleId);
}

async function handleCompanyResearch(db: Database.Database, companyId: number): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const recipe = getSourceRecipe('company_research');
  const context = JSON.stringify({ name: company.name, url: company.url, description: company.description });

  const extraction = (await runExtraction(
    researchWebScript,
    ['company', recipe.instructions],
    context,
  )) as CompanyResearchExtraction;

  const aiProofScore = typeof extraction.aiProofScore === 'number' ? extraction.aiProofScore : null;

  updateCompanyResearchFields(db, companyId, {
    ipoStatus: extraction.ipoStatus ?? null,
    aiProofScore,
    aiProofNotes: extraction.aiProofNotes ?? null,
  });

  recordEvent(db, {
    entityType: 'company',
    entityId: companyId,
    type: 'company.research_completed',
    context: { ipoStatus: extraction.ipoStatus ?? null, aiProofScore },
  });

  recomputePriorityForCompanyRoles(db, companyId);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function substituteTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? '');
}

async function handleCompanyWlb(db: Database.Database, companyId: number): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const recipe = getSourceRecipe('company_wlb');
  if (!recipe.urlTemplate) {
    // WLB is login-gated (Glassdoor et al.) — unlike comp/IPO/AI-proof
    // research, there's no "fall back to open web search" option here,
    // since claude -p's web search can't see past a login wall. Without a
    // real URL template this job can't do anything useful yet; that's
    // expected until one is supplied (per the original design: "you'll
    // supply real example URLs to tighten these"), not an error.
    recordEvent(db, {
      entityType: 'company',
      entityId: companyId,
      type: 'company.wlb_skipped',
      context: {
        reason:
          'no urlTemplate configured for company_wlb in sources.json — add one (e.g. a Glassdoor reviews URL pattern) to enable WLB research',
      },
    });
    return;
  }

  const url = substituteTemplate(recipe.urlTemplate, {
    companyName: company.name ?? '',
    companySlug: slugify(company.name ?? ''),
  });
  const html = await fetchAuthenticatedPage(url);
  const extraction = (await runExtraction(extractWlbScript, [], html)) as WlbExtraction;

  const wlbScore = typeof extraction.wlbScore === 'number' ? extraction.wlbScore : null;

  updateCompanyResearchFields(db, companyId, {
    wlbScore,
    wlbNotes: extraction.wlbNotes ?? null,
  });

  recordEvent(db, {
    entityType: 'company',
    entityId: companyId,
    type: 'company.wlb_completed',
    context: { wlbScore },
  });

  recomputePriorityForCompanyRoles(db, companyId);
}
