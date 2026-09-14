import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Preferences } from '../../config/preferences.js';
import { loadPreferences } from '../../config/preferences.js';
import { getCompanyById } from '../../db/repositories/companies.js';
import { DuplicateError } from '../../db/errors.js';
import { recordEvent } from '../../db/repositories/events.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import { createRole, findRoleByUrl } from '../../db/repositories/roles.js';
import { contextKey, recipeVersion } from '../../derive/keys.js';
import { roleStructuralPayload } from '../../domain/enrichment-payload.js';
import { recordDerivation } from '../../derive/record.js';
import { runTrackedExtraction } from '../../enrichment/tracked-extraction.js';
import { matchesPreferences } from '../../domain/preference-match.js';
import { gateDiscoveredUrl, type GateVerdict } from '../../derive/discover-gate.js';
import { isHttpUrl } from '../../lib/is-http-url.js';
import type { NotificationJobPayload } from './notification.js';

const discoverScript = fileURLToPath(new URL('../../enrichment/scripts/research-discover.sh', import.meta.url));

export type DiscoveryJobPayload = { kind: 'company-discover'; companyId: number };

interface DiscoverExtraction {
  roles?: { title?: string | null; url?: string | null }[] | null;
}

export interface ApplyDiscoveredRolesResult {
  created: number;
  /** Rejected on preferences, a bad URL, or already being tracked. Disjoint from `closed`. */
  skipped: number;
  /** Rejected by the gate as an already-closed posting, so never created. Disjoint from `skipped`. */
  closed: number;
}

/** Five minutes of gating leaves a discover job comfortably inside `stale_running_job_minutes` (30). */
const DEFAULT_GATE_BUDGET_MS = 5 * 60 * 1000;

/** What a candidate gets once the gating budget is spent: tracked, as it would have been anyway. */
const ungated: GateVerdict = { track: true, reason: 'undetermined' };

export async function handleDiscoveryJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as DiscoveryJobPayload;
  if (payload.kind !== 'company-discover') {
    throw new Error(`Unknown discovery job payload: ${job.payload}`);
  }
  await handleCompanyDiscover(db, payload.companyId, job.id);
}

async function handleCompanyDiscover(db: Database.Database, companyId: number, jobId: number): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const preferences = loadPreferences();
  const context = JSON.stringify({
    companyName: company.name,
    companyUrl: company.url,
    preferences,
  });

  const { data, usage } = await runTrackedExtraction(
    db,
    { entityType: 'company', entityId: companyId, kind: 'company_discover', jobId },
    discoverScript,
    [],
    context,
  );
  const extraction = data as DiscoverExtraction;

  // Recorded for spend reporting only — discover is never skipped as
  // "fresh". Its whole job is to find postings that did not exist last
  // time, and its context (the company and your preferences) barely
  // changes, so a freshness gate would make the command a permanent no-op.
  recordDerivation(db, {
    entityType: 'company',
    entityId: companyId,
    kind: 'company_discover',
    key: { sourceKey: contextKey(context), recipeVersion: recipeVersion(discoverScript) },
    usage,
    jobId,
  });

  await applyDiscoveredRoles(db, companyId, extraction, preferences);
}

export interface ApplyDiscoveredRolesOptions {
  /**
   * Overridable so the filtering/dedupe logic stays testable without a
   * network: the real gate is covered directly in `discover-gate.test.ts`.
   */
  gate?: (db: Database.Database, url: string) => Promise<GateVerdict>;
  /**
   * Wall-clock budget for gating one discover run.
   *
   * Gating is N serial fetches at up to 15 s each, and
   * `requeueStaleRunningJobs` rests on "nothing legitimate runs for 30
   * minutes". A company returning a hundred candidates on slow hosts would
   * blow through that, and the sweep would requeue a still-running
   * discover into a *second* paid web search. Past the budget, remaining
   * candidates are tracked ungated — exactly the behaviour before this
   * gate existed.
   */
  gateBudgetMs?: number;
}

/**
 * Exported for direct testing of the candidate-filtering/dedup/create logic
 * without needing a real claude -p web-search call — mirrors
 * enrichment.ts's `resolveRoleCompany` split (live call vs. what-to-do-with-
 * the-result are separate, independently testable functions).
 */
export async function applyDiscoveredRoles(
  db: Database.Database,
  companyId: number,
  extraction: DiscoverExtraction,
  preferences: Preferences,
  options: ApplyDiscoveredRolesOptions = {},
): Promise<ApplyDiscoveredRolesResult> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const gate = options.gate ?? gateDiscoveredUrl;
  const gateBudgetMs = options.gateBudgetMs ?? DEFAULT_GATE_BUDGET_MS;
  const gatingDeadline = Date.now() + gateBudgetMs;
  const candidates = extraction.roles ?? [];
  let created = 0;
  let skipped = 0;
  let closed = 0;

  for (const candidate of candidates) {
    const url = candidate.url?.trim();
    const title = candidate.title?.trim() || null;

    if (!url || !isHttpUrl(url) || !matchesPreferences(title, preferences)) {
      skipped++;
      continue;
    }

    // The cheapest rejection, and the common one: re-running discover
    // mostly re-surfaces roles already tracked. Gating first meant every
    // one of those paid an HTTP fetch and a snapshot row per run — and a
    // duplicate whose page had since closed was booked as a closure rather
    // than as the duplicate it is.
    if (findRoleByUrl(db, url, companyId)) {
      skipped++;
      continue;
    }

    try {
      // Checked before the role exists, not after: a role created from a
      // dead URL immediately queues a structural extraction and a research
      // call, so the cheapest moment to find out is now.
      const verdict = Date.now() < gatingDeadline ? await gate(db, url) : ungated;
      if (!verdict.track) {
        recordEvent(db, {
          entityType: 'company',
          entityId: companyId,
          type: 'company.discover_candidate_closed',
          context: { url, title, reason: verdict.reason, detail: verdict.detail },
        });
        // Counted on its own, not also as `skipped`: a consumer adding the
        // three up would double-count, and "skipped" would stop meaning
        // "rejected on preferences or already tracked".
        closed++;
        continue;
      }

      const role = createRole(db, { companyId, url });
      enqueueJob(db, { topic: 'enrichment', payload: roleStructuralPayload(role.id) });
      recordEvent(db, {
        entityType: 'role',
        entityId: role.id,
        type: 'role.discovered',
        context: { title, companyId },
      });
      created++;
    } catch (error) {
      if (error instanceof DuplicateError) {
        // Already tracked (manually added, or found by an earlier discover
        // run) — not a new candidate, just skip it silently.
        skipped++;
        continue;
      }
      // Any other per-candidate failure (e.g. a transient DB error
      // enqueueing the follow-up enrichment job) must not abort the rest
      // of this batch — record it and move on, rather than losing every
      // remaining candidate in this discover run over one bad one.
      recordEvent(db, {
        entityType: 'company',
        entityId: companyId,
        type: 'company.discover_candidate_failed',
        context: { url, title, error: error instanceof Error ? error.message : String(error) },
      });
      skipped++;
    }
  }

  recordEvent(db, {
    entityType: 'company',
    entityId: companyId,
    type: 'company.discover_completed',
    context: { candidatesFound: candidates.length, created, skipped, closed },
  });

  if (created > 0) {
    // A distinct eventType from the 'company.discover_completed' summary
    // event just recorded above — handleNotificationJob records its own
    // event from this payload's eventType, so reusing the same string
    // would double-record one event for a single discover run (the same
    // class of bug refresh.ts avoids with 'role.closed_detected' vs
    // 'role.closed').
    const notification: NotificationJobPayload = {
      entityType: 'company',
      entityId: companyId,
      eventType: 'company.roles_discovered',
      message: `Discovered ${created} new role(s) at ${company.name ?? company.url}`,
      context: { created },
    };
    enqueueJob(db, { topic: 'notification', payload: notification });
  }

  return { created, skipped, closed };
}
