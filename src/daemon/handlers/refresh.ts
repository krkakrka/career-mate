import type Database from 'better-sqlite3';
import { getCompanyById } from '../../db/repositories/companies.js';
import { recordEvent } from '../../db/repositories/events.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import { getRoleById, markClosed, markLastChecked } from '../../db/repositories/roles.js';
import { combinedRecipeVersion, type DerivationKey } from '../../derive/keys.js';
import type { ExtractionUsage } from '../../enrichment/claude-extract.js';
import { recordDerivation, skipIfFresh } from '../../derive/record.js';
import { closurePhrasesPath, closureScriptPath, decideClosure } from '../../derive/closure.js';
import { FetchError } from '../../pages/fetch.js';
import { readSnapshotText, snapshotPage } from '../../pages/store.js';
import type { NotificationJobPayload } from './notification.js';

export type RefreshJobPayload = { kind: 'role-closure-check'; roleId: number };

/**
 * Closure's recipe is the phrase list *then* the script, so editing either
 * one changes how the answer would be reached — and must invalidate what
 * the old procedure produced, whichever half actually decided.
 */
function closureRecipeVersion(): string {
  return combinedRecipeVersion([closurePhrasesPath, closureScriptPath]);
}

export async function handleRefreshJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as RefreshJobPayload;
  if (payload.kind !== 'role-closure-check') {
    throw new Error(`Unknown refresh job payload: ${job.payload}`);
  }
  await handleRoleClosureCheck(db, payload.roleId, job.id);
}

/** Exported for direct testing of the closure-decision logic without needing a real fetch/claude -p call. */
export async function handleRoleClosureCheck(
  db: Database.Database,
  roleId: number,
  jobId: number | null = null,
): Promise<void> {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`Role #${roleId} not found`);
  if (role.closed_at != null) return; // already known closed — nothing to do

  let closed = false;
  let reason: string | null = null;
  // Carried out of the try so the derivation can be written *after* every
  // effect of this check has landed — see the note at the bottom.
  let derivation: { key: DerivationKey; usage: ExtractionUsage | undefined } | undefined;

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
    const key = { sourceKey: snapshot.text_hash!, recipeVersion: closureRecipeVersion() };
    // The page is byte-identical to the one we last judged, by the same
    // procedure — so the verdict is too. A role already judged closed
    // returned at the top of this function, so reaching here with a fresh
    // derivation means "still open", and the only thing left is to record
    // that we looked.
    if (skipIfFresh(db, 'role', roleId, 'role_closure', key)) {
      markLastChecked(db, roleId);
      return;
    }

    const verdict = await decideClosure(readSnapshotText(snapshot), {
      track: { db, tracking: { entityType: 'role', entityId: roleId, kind: 'role_closure', jobId } },
    });
    closed = verdict.status === 'closed';
    reason = verdict.reason;

    derivation = { key, usage: verdict.usage };
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

  const company = role.company_id != null ? getCompanyById(db, role.company_id) : undefined;
  const label = role.title ?? role.url;
  const companyLabel = company?.name ? ` at ${company.name}` : '';

  /**
   * One transaction for every effect of this check, with the derivation
   * written last and inside it.
   *
   * The derivation row is the claim "this page text has been judged", and
   * the next check skips the model on the strength of it. Writing it before
   * the closure is recorded and notified would mean a transient failure in
   * between leaves a role that is closed, known to be closed, and never
   * reported — because the retry would see a fresh derivation and skip.
   *
   * There is deliberately no derivation on the HTTP 404/410 path: that
   * verdict comes from the fetch failing, not from any text, so there is no
   * source key to record it against.
   */
  const apply = db.transaction(() => {
    markLastChecked(db, roleId);

    if (closed) {
      const { wasNewlyClosed } = markClosed(db, roleId);
      // An overlapping closure check already recorded this — don't double-notify.
      if (wasNewlyClosed) {
        recordEvent(db, { entityType: 'role', entityId: roleId, type: 'role.closed_detected', context: { reason } });

        const notification: NotificationJobPayload = {
          entityType: 'role',
          entityId: roleId,
          eventType: 'role.closed',
          message: `Role closed: ${label}${companyLabel} (#${roleId})`,
          context: { reason },
        };
        enqueueJob(db, { topic: 'notification', payload: notification });
      }
    }

    if (derivation) {
      recordDerivation(db, {
        entityType: 'role',
        entityId: roleId,
        kind: 'role_closure',
        key: derivation.key,
        usage: derivation.usage,
        jobId,
      });
    }
  });
  apply.immediate();
}
