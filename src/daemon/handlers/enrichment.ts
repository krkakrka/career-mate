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
import { contextKey, recipeVersion, sha256 } from '../../derive/keys.js';
import { researchRecipeVersion, structuralRecipeVersion } from '../../derive/recipes.js';
import { recordDerivation, skipIfFresh } from '../../derive/record.js';
import {
  COMPANY_STRUCTURAL_FIELDS,
  missingFields,
  prefillCompanyStructural,
  prefillRoleStructural,
  ROLE_STRUCTURAL_FIELDS,
} from '../../derive/structural.js';
import { runTrackedExtraction } from '../../enrichment/tracked-extraction.js';
import { buildCompanyResearchContext, buildRoleResearchContext } from '../../enrichment/research-context.js';
import { getSourceRecipe } from '../../enrichment/sources.js';
import {
  companyResearchPayload,
  companyStructuralPayload,
  companyWlbPayload,
  roleResearchPayload,
} from '../../domain/enrichment-payload.js';
import { isHttpUrl } from '../../lib/is-http-url.js';
import { readSnapshotHtml, readSnapshotText, snapshotPage } from '../../pages/store.js';

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
      await handleCompanyStructural(db, payload.companyId, payload.force ?? false, job.id);
      return;
    case 'role-structural':
      await handleRoleStructural(db, payload.roleId, payload.force ?? false, job.id);
      return;
    case 'role-research':
      await handleRoleResearch(db, payload.roleId, job.id);
      return;
    case 'company-research':
      await handleCompanyResearch(db, payload.companyId, job.id);
      return;
    case 'company-wlb':
      await handleCompanyWlb(db, payload.companyId, job.id);
      return;
    default:
      throw new Error(`Unknown enrichment job payload: ${job.payload}`);
  }
}

async function handleCompanyStructural(
  db: Database.Database,
  companyId: number,
  force: boolean,
  jobId: number,
): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const snapshot = await snapshotPage(db, company.url, { kind: 'company', force });
  const text = readSnapshotText(snapshot);
  const key = { sourceKey: snapshot.text_hash!, recipeVersion: structuralRecipeVersion() };

  // Nothing about the input or the recipe changed, so the answer would be
  // identical — the chained research jobs below still run, since their own
  // freshness is their own question.
  //
  // `force` bypasses this. The Phase 2 model says --force means only "take
  // a new snapshot", on the reasoning that a changed snapshot makes
  // derivations stale by itself — but that leaves no way at all to redo an
  // extraction the model simply got wrong, because re-fetching an unchanged
  // page produces the same text hash and skips. A user asking to re-fetch
  // and re-enrich is asking for the value to be recomputed; the command
  // saying "Re-enrichment queued" while deriving nothing is worse than the
  // small extra cost. (Correction recorded in PLAN.md's model section.)
  if (!force && skipIfFresh(db, 'company', companyId, 'company_structural', key)) {
    enqueueJob(db, { topic: 'enrichment', payload: companyResearchPayload(companyId) });
    enqueueJob(db, { topic: 'enrichment', payload: companyWlbPayload(companyId) });
    return;
  }

  // What the page states about itself is free and more reliable than a
  // model's reading of it; the model is asked only for the remainder.
  const prefill = prefillCompanyStructural(readSnapshotHtml(snapshot));
  const wanted = missingFields(COMPANY_STRUCTURAL_FIELDS, prefill);
  // The empty-`wanted` branch is unreachable today (no rule prefills
  // `description`), and kept deliberately: it is what makes adding one
  // later skip the call rather than silently re-ask for every field, since
  // an empty field list makes the script fall back to all of them.
  const result = wanted.length
    ? await runTrackedExtraction(
        db,
        { entityType: 'company', entityId: companyId, kind: 'company_structural', jobId },
        structuralScript,
        ['company', wanted.join(',')],
        text,
      )
    : undefined;
  const extraction = (result?.data ?? {}) as CompanyStructuralExtraction;

  const name = prefill.name ?? extraction.name ?? null;

  // See handleRoleStructural: the derivation row goes last, inside the
  // transaction, so it can never claim work that did not fully land.
  const apply = db.transaction(() => {
    updateCompanyStructuralFields(db, companyId, {
      name,
      description: extraction.description ?? null,
    });

    recordEvent(db, {
      entityType: 'company',
      entityId: companyId,
      type: 'company.structural_fetch_completed',
      context: { name, modelFields: wanted },
    });

    recordDerivation(db, {
      entityType: 'company',
      entityId: companyId,
      kind: 'company_structural',
      key,
      usage: result?.usage,
      jobId,
    });
  });
  apply.immediate();

  // Structural fetch is the fast/cheap pass; full research follows
  // automatically, per the architecture (fast structural now, deeper
  // research as a separate job after).
  enqueueJob(db, { topic: 'enrichment', payload: companyResearchPayload(companyId) });
  enqueueJob(db, { topic: 'enrichment', payload: companyWlbPayload(companyId) });
}

async function handleRoleStructural(
  db: Database.Database,
  roleId: number,
  force: boolean,
  jobId: number,
): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);

  // snapshotPage + runExtraction below take several seconds — don't trust
  // role.company_id captured before them by the time we're deciding
  // whether to resolve a company; re-read fresh right before that check.
  const snapshot = await snapshotPage(db, role.url, { kind: 'role', force });
  const text = readSnapshotText(snapshot);
  const key = { sourceKey: snapshot.text_hash!, recipeVersion: structuralRecipeVersion() };

  // See handleCompanyStructural on why `force` bypasses the freshness skip.
  if (!force && skipIfFresh(db, 'role', roleId, 'role_structural', key)) {
    enqueueJob(db, { topic: 'enrichment', payload: roleResearchPayload(roleId) });
    return;
  }

  const prefill = prefillRoleStructural(readSnapshotHtml(snapshot));
  const wanted = missingFields(ROLE_STRUCTURAL_FIELDS, prefill);
  // See the note in handleCompanyStructural on the empty-`wanted` branch.
  const result = wanted.length
    ? await runTrackedExtraction(
        db,
        { entityType: 'role', entityId: roleId, kind: 'role_structural', jobId },
        structuralScript,
        ['role', wanted.join(',')],
        text,
      )
    : undefined;
  const extraction = (result?.data ?? {}) as RoleStructuralExtraction;

  const title = prefill.title ?? extraction.title ?? null;

  // Everything this derivation produced lands in one transaction, with the
  // derivation row written LAST and inside it. The row is the claim "this
  // input has been fully processed", so it must not become true while any
  // effect of processing is still missing: recording it earlier meant a
  // transient failure in company resolution left a role permanently
  // unresolved, because the retry saw a fresh derivation and skipped
  // everything. (Observed as a real test failure, not a hypothetical.)
  const apply = db.transaction(() => {
    updateRoleStructuralFields(db, roleId, {
      title,
      description: extraction.description ?? null,
    });

    recordEvent(db, {
      entityType: 'role',
      entityId: roleId,
      type: 'role.structural_fetch_completed',
      context: { title, modelFields: wanted },
    });

    const currentRole = getRoleById(db, roleId);
    if (currentRole?.company_id == null) {
      resolveRoleCompany(db, roleId, extraction);
    }

    recordDerivation(db, {
      entityType: 'role',
      entityId: roleId,
      kind: 'role_structural',
      key,
      usage: result?.usage,
      jobId,
    });
  });
  apply.immediate();

  enqueueJob(db, { topic: 'enrichment', payload: roleResearchPayload(roleId) });
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
    enqueueJob(db, { topic: 'enrichment', payload: companyStructuralPayload(company.id) });
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
async function handleRoleResearch(db: Database.Database, roleId: number, jobId: number): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);

  const recipe = getSourceRecipe('role_research');
  const context = buildRoleResearchContext(db, role);

  // These kinds read no page, so their input is the context JSON itself —
  // hashing the exact string piped in means the key changes when, and only
  // when, what the model saw changed.
  const key = { sourceKey: contextKey(context), recipeVersion: researchRecipeVersion() };
  if (skipIfFresh(db, 'role', roleId, 'role_research', key)) return;

  const { data, usage } = await runTrackedExtraction(
    db,
    { entityType: 'role', entityId: roleId, kind: 'role_research', jobId },
    researchWebScript,
    ['role', recipe.instructions],
    context,
  );
  const extraction = data as RoleResearchExtraction;

  const salaryMin = typeof extraction.salaryMin === 'number' ? extraction.salaryMin : null;
  const salaryMax = typeof extraction.salaryMax === 'number' ? extraction.salaryMax : null;

  const apply = db.transaction(() => {
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

    recordDerivation(db, { entityType: 'role', entityId: roleId, kind: 'role_research', key, usage, jobId });
  });
  apply.immediate();
}

async function handleCompanyResearch(db: Database.Database, companyId: number, jobId: number): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const recipe = getSourceRecipe('company_research');
  const context = buildCompanyResearchContext(company);

  const key = { sourceKey: contextKey(context), recipeVersion: researchRecipeVersion() };
  if (skipIfFresh(db, 'company', companyId, 'company_research', key)) return;

  const { data, usage } = await runTrackedExtraction(
    db,
    { entityType: 'company', entityId: companyId, kind: 'company_research', jobId },
    researchWebScript,
    ['company', recipe.instructions],
    context,
  );
  const extraction = data as CompanyResearchExtraction;

  const aiProofScore = typeof extraction.aiProofScore === 'number' ? extraction.aiProofScore : null;

  const apply = db.transaction(() => {
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

    recordDerivation(db, { entityType: 'company', entityId: companyId, kind: 'company_research', key, usage, jobId });
  });
  apply.immediate();
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

async function handleCompanyWlb(db: Database.Database, companyId: number, jobId: number): Promise<void> {
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
  // The only fetch that does not go through the page store (it needs the
  // authenticated browser profile), so its source key is the hash of the
  // HTML it returned rather than a snapshot's text_hash.
  const key = { sourceKey: sha256(html), recipeVersion: recipeVersion(extractWlbScript) };
  if (skipIfFresh(db, 'company', companyId, 'company_wlb', key)) return;

  const { data, usage } = await runTrackedExtraction(
    db,
    { entityType: 'company', entityId: companyId, kind: 'company_wlb', jobId },
    extractWlbScript,
    [],
    html,
  );
  const extraction = data as WlbExtraction;

  const wlbScore = typeof extraction.wlbScore === 'number' ? extraction.wlbScore : null;

  const apply = db.transaction(() => {
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

    recordDerivation(db, { entityType: 'company', entityId: companyId, kind: 'company_wlb', key, usage, jobId });
  });
  apply.immediate();
}
