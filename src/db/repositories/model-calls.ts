import type Database from 'better-sqlite3';
import type { DerivationKind } from './derivations.js';
import type { EntityType } from '../../domain/entity-type.js';
import { getOrigin } from '../../lib/origin.js';

export interface ModelCallRecord {
  id: number;
  occurred_at: string;
  entity_type: EntityType | null;
  entity_id: number | null;
  kind: string;
  model: string;
  cost_usd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  job_id: number | null;
  /** The surface that caused the spend, copied here rather than joined — see migration 0011. */
  origin: string | null;
}

export interface RecordModelCallParams {
  entityType?: EntityType | null;
  entityId?: number | null;
  kind: DerivationKind;
  model: string;
  costUsd: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  jobId?: number | null;
}

/**
 * The surface to stamp on a ledger row, or null when nothing recorded one.
 *
 * Read from the job where there is one, rather than trusting the ambient
 * origin. In production the two agree — `runTrackedExtraction` runs inside
 * the worker's `withOrigin(job.origin)` scope — but "agrees in production"
 * is not the same as "cannot disagree", and a model call made with a
 * `jobId` from outside that scope would otherwise bill the wrong surface
 * while looking entirely correct. The ambient origin remains the answer for
 * a call with no job behind it.
 */
function originFor(db: Database.Database, jobId: number | null): string | null {
  // No job behind the call: the process that made it is the cause, and the
  // ambient origin is exactly that.
  if (jobId === null) return getOrigin();

  const row = db.prepare('SELECT origin FROM jobs WHERE id = ?').get(jobId) as { origin: string | null } | undefined;
  // A job whose own origin is NULL stays NULL — never the ambient one. NULL
  // means "not recorded" (every job predating migration 0010), and falling
  // back to the running process would bill a batch of legacy work to
  // whichever surface happened to drain it. That is the same mistake the
  // worker's fallback made, caught in Step 26's review.
  //
  // A `jobId` naming no row gets the same answer, not the ambient one. With
  // `foreign_keys = ON` the INSERT that follows fails anyway, so this is
  // unreachable today; if it ever stops being, it must not commit the exact
  // misattribution the line above forbids.
  return row?.origin ?? null;
}

/**
 * Appends one call to the spend ledger. Never updated, never replaced —
 * that is the whole point: a total of what has been spent has to count
 * every call, including ones whose derived value has since been recomputed
 * or replaced by a free deterministic result.
 *
 * Self-contained by design: the surface is stamped here rather than read
 * back through `job_id`, so pruning a completed job cannot rewrite what the
 * ledger says was spent or who caused it.
 */
export function recordModelCall(db: Database.Database, params: RecordModelCallParams): ModelCallRecord {
  const result = db
    .prepare(
      `INSERT INTO model_calls (entity_type, entity_id, kind, model, cost_usd, input_tokens, output_tokens, job_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.entityType ?? null,
      params.entityId ?? null,
      params.kind,
      params.model,
      params.costUsd,
      params.inputTokens ?? null,
      params.outputTokens ?? null,
      params.jobId ?? null,
      originFor(db, params.jobId ?? null),
    );

  return db.prepare('SELECT * FROM model_calls WHERE id = ?').get(result.lastInsertRowid) as ModelCallRecord;
}

export interface ModelSpend {
  totalUsd: number;
  calls: number;
}

export function spendSince(db: Database.Database, sinceIso: string): ModelSpend {
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS calls FROM model_calls WHERE occurred_at >= ?')
    .get(sinceIso) as { total: number; calls: number };
  return { totalUsd: row.total, calls: row.calls };
}
