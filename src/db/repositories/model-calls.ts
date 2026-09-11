import type Database from 'better-sqlite3';
import type { DerivationKind } from './derivations.js';
import type { EntityType } from '../../domain/entity-type.js';

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
 * Appends one call to the spend ledger. Never updated, never replaced —
 * that is the whole point: a total of what has been spent has to count
 * every call, including ones whose derived value has since been recomputed
 * or replaced by a free deterministic result.
 */
export function recordModelCall(db: Database.Database, params: RecordModelCallParams): ModelCallRecord {
  const result = db
    .prepare(
      `INSERT INTO model_calls (entity_type, entity_id, kind, model, cost_usd, input_tokens, output_tokens, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
