import type Database from 'better-sqlite3';
import type { EnrichmentJobPayload } from '../daemon/handlers/enrichment.js';
import { enqueueJob } from '../db/repositories/jobs.js';
import { ensureDaemonRunning } from '../lib/daemon-control.js';

/** Enqueues an enrichment job and makes sure something's alive to pick it up — the shared tail end of `add` commands. */
export function enqueueEnrichment(db: Database.Database, payload: EnrichmentJobPayload): void {
  enqueueJob(db, { topic: 'enrichment', payload });
  ensureDaemonRunning();
}
