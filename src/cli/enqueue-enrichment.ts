import type Database from 'better-sqlite3';
import type { EnrichmentJobPayload } from '../daemon/handlers/enrichment.js';
import { enqueueJob } from '../db/repositories/jobs.js';
import { enqueueRecomputes, type FieldGroupStatus } from '../derive/view-staleness.js';
import type { EntityType } from '../domain/entity-type.js';
import { ensureDaemonRunning } from '../lib/daemon-control.js';

/** Enqueues an enrichment job and makes sure something's alive to pick it up — the shared tail end of `add` commands. */
export function enqueueEnrichment(db: Database.Database, payload: EnrichmentJobPayload): void {
  enqueueJob(db, { topic: 'enrichment', payload });
  ensureDaemonRunning();
}

/**
 * Queues recomputes for the stale field groups a read just surfaced, and —
 * crucially — makes sure something is alive to run them.
 *
 * The daemon is kicked whenever anything is out of date, NOT only when this
 * call enqueued something new. Those are different conditions, and the
 * difference is the whole bug: after a reboot the job from `add` is still
 * sitting `pending` with no daemon running, so a read enqueues nothing
 * (the debounce matches that pending row) — and if the kick were tied to
 * enqueueing, no read would ever start a worker and the entity would print
 * `(stale)` forever. Anything out of date means there may be work waiting,
 * so make sure a worker exists.
 *
 * `ensureDaemonRunning` is a pid-file check before it is anything else, so
 * calling it once per row of a list is cheap.
 */
export function enqueueRecomputesAndRun(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  groups: FieldGroupStatus[],
): void {
  if (queueRecomputes(db, entityType, entityId, groups)) ensureDaemonRunning();
}

/**
 * The same queueing without the daemon kick, returning whether anything is
 * outstanding — for list views, which must kick *once* rather than once per
 * row. `ensureDaemonRunning` spawns detached and returns before the child
 * has claimed the pid file, so calling it per row on a long list races a
 * daemon per row into existence; they exit cleanly on losing the pid-file
 * claim, but every one of them is a wasted node startup.
 */
export function queueRecomputes(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  groups: FieldGroupStatus[],
): boolean {
  if (groups.length === 0) return false;
  enqueueRecomputes(db, entityType, entityId, groups);
  return true;
}
