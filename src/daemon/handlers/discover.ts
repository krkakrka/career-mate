import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Preferences } from '../../config/preferences.js';
import { loadPreferences } from '../../config/preferences.js';
import { getCompanyById } from '../../db/repositories/companies.js';
import { DuplicateError } from '../../db/errors.js';
import { recordEvent } from '../../db/repositories/events.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import { createRole } from '../../db/repositories/roles.js';
import { runExtraction } from '../../enrichment/claude-extract.js';
import { matchesPreferences } from '../../domain/preference-match.js';
import { isHttpUrl } from '../../lib/is-http-url.js';
import type { NotificationJobPayload } from './notification.js';

const discoverScript = fileURLToPath(new URL('../../enrichment/scripts/research-discover.sh', import.meta.url));

export type DiscoveryJobPayload = { kind: 'company-discover'; companyId: number };

interface DiscoverExtraction {
  roles?: { title?: string | null; url?: string | null }[] | null;
}

export interface ApplyDiscoveredRolesResult {
  created: number;
  skipped: number;
}

export async function handleDiscoveryJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as DiscoveryJobPayload;
  if (payload.kind !== 'company-discover') {
    throw new Error(`Unknown discovery job payload: ${job.payload}`);
  }
  await handleCompanyDiscover(db, payload.companyId);
}

async function handleCompanyDiscover(db: Database.Database, companyId: number): Promise<void> {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const preferences = loadPreferences();
  const context = JSON.stringify({
    companyName: company.name,
    companyUrl: company.url,
    preferences,
  });

  const extraction = (await runExtraction(discoverScript, [], context)) as DiscoverExtraction;
  applyDiscoveredRoles(db, companyId, extraction, preferences);
}

/**
 * Exported for direct testing of the candidate-filtering/dedup/create logic
 * without needing a real claude -p web-search call — mirrors
 * enrichment.ts's `resolveRoleCompany` split (live call vs. what-to-do-with-
 * the-result are separate, independently testable functions).
 */
export function applyDiscoveredRoles(
  db: Database.Database,
  companyId: number,
  extraction: DiscoverExtraction,
  preferences: Preferences,
): ApplyDiscoveredRolesResult {
  const company = getCompanyById(db, companyId);
  if (!company) throw new Error(`Company #${companyId} not found`);

  const candidates = extraction.roles ?? [];
  let created = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const url = candidate.url?.trim();
    const title = candidate.title?.trim() || null;

    if (!url || !isHttpUrl(url) || !matchesPreferences(title, preferences)) {
      skipped++;
      continue;
    }

    try {
      const role = createRole(db, { companyId, url });
      enqueueJob(db, { topic: 'enrichment', payload: { kind: 'role-structural', roleId: role.id } });
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
    context: { candidatesFound: candidates.length, created, skipped },
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

  return { created, skipped };
}
