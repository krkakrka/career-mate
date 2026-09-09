import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { getCompanyById } from '../../db/repositories/companies.js';
import { recordEvent } from '../../db/repositories/events.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import { getRoleById, markClosed, markLastChecked } from '../../db/repositories/roles.js';
import { runExtraction } from '../../enrichment/claude-extract.js';
import { fetchPageContent, FetchError } from '../../enrichment/fetch-page.js';
import type { NotificationJobPayload } from './notification.js';

const closureScript = fileURLToPath(new URL('../../enrichment/scripts/extract-closure-status.sh', import.meta.url));

export type RefreshJobPayload = { kind: 'role-closure-check'; roleId: number };

interface ClosureExtraction {
  status?: 'open' | 'closed' | 'unknown' | null;
  reason?: string | null;
}

export async function handleRefreshJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as RefreshJobPayload;
  if (payload.kind !== 'role-closure-check') {
    throw new Error(`Unknown refresh job payload: ${job.payload}`);
  }
  await handleRoleClosureCheck(db, payload.roleId);
}

/** Exported for direct testing of the closure-decision logic without needing a real fetch/claude -p call. */
export async function handleRoleClosureCheck(db: Database.Database, roleId: number): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);
  if (role.closed_at != null) return; // already known closed — nothing to do

  let closed = false;
  let reason: string | null = null;

  try {
    const html = await fetchPageContent(role.url);
    const extraction = (await runExtraction(closureScript, [], html)) as ClosureExtraction;
    closed = extraction.status === 'closed';
    reason = extraction.reason ?? null;
  } catch (error) {
    if (error instanceof FetchError && (error.status === 404 || error.status === 410)) {
      // A definitive "this resource is gone" status needs no claude call at
      // all to know the posting is gone — 404 Not Found and 410 Gone both
      // qualify (410 is the more spec-correct status for a deliberately
      // removed posting, and some ATSes use it instead of 404).
      closed = true;
      reason = `page returned HTTP ${error.status}`;
    } else {
      // Transient fetch/extraction failure — let the job retry via the
      // queue's own backoff rather than treating "couldn't check" as "closed".
      throw error;
    }
  }

  markLastChecked(db, roleId);
  if (!closed) return;

  const { wasNewlyClosed } = markClosed(db, roleId);
  if (!wasNewlyClosed) return; // an overlapping closure check already recorded this — don't double-notify

  recordEvent(db, { entityType: 'role', entityId: roleId, type: 'role.closed_detected', context: { reason } });

  const company = role.company_id != null ? getCompanyById(db, role.company_id) : undefined;
  const label = role.title ?? role.url;
  const companyLabel = company?.name ? ` at ${company.name}` : '';

  const notification: NotificationJobPayload = {
    entityType: 'role',
    entityId: roleId,
    eventType: 'role.closed',
    message: `Role closed: ${label}${companyLabel} (#${roleId})`,
    context: { reason },
  };
  enqueueJob(db, { topic: 'notification', payload: notification });
}
