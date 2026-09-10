import type Database from 'better-sqlite3';
import { getCompanyById } from '../../db/repositories/companies.js';
import { recordEvent } from '../../db/repositories/events.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import { getRoleById, markClosed, markLastChecked } from '../../db/repositories/roles.js';
import { decideClosure } from '../../derive/closure.js';
import { FetchError } from '../../pages/fetch.js';
import { readSnapshotText, snapshotPage } from '../../pages/store.js';
import type { NotificationJobPayload } from './notification.js';

export type RefreshJobPayload = { kind: 'role-closure-check'; roleId: number };

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
    // Always a new snapshot, never the refresh window. "Has this posting
    // closed?" is a question about the live page by definition: reusing a
    // snapshot up to page_refresh_days.role old would answer it from
    // three-day-old text, stamp last_checked_at as though we had looked,
    // and — because the model call below happens either way — cost exactly
    // the same money for the staler answer. The window governs `add` and
    // `rerun-enrichment`, where re-fetching a page you just fetched really
    // is waste.
    const snapshot = await snapshotPage(db, role.url, { kind: 'role', force: true });
    // Deterministic first: an unambiguous "this posting is gone" phrase
    // settles it for free, and only the remainder costs a model call.
    const verdict = await decideClosure(readSnapshotText(snapshot));
    closed = verdict.status === 'closed';
    reason = verdict.reason;
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
