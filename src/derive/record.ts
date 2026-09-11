import type Database from 'better-sqlite3';
import { upsertDerivation, type DerivationKind } from '../db/repositories/derivations.js';
import { recordEvent } from '../db/repositories/events.js';
import type { EntityType } from '../domain/entity-type.js';
import type { ExtractionUsage } from '../enrichment/claude-extract.js';
import type { DerivationKey } from './keys.js';
import { isFresh } from './staleness.js';

/**
 * Whether this job can stop before spending anything: the value on record
 * was computed from exactly this input by exactly this recipe, so
 * recomputing it would produce the same answer at full price.
 *
 * Records a `*.derivation_fresh` event when it skips, so "nothing
 * happened" is visible in the audit trail rather than looking like a job
 * that silently did nothing.
 */
export function skipIfFresh(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
  key: DerivationKey,
): boolean {
  if (!isFresh(db, entityType, entityId, kind, key)) return false;

  recordEvent(db, {
    entityType,
    entityId,
    type: `${entityType}.derivation_fresh`,
    context: { kind },
  });
  return true;
}

export interface RecordDerivationParams {
  entityType: EntityType;
  entityId: number;
  kind: DerivationKind;
  key: DerivationKey;
  /** Absent for a derivation a deterministic rule produced, which spends nothing. */
  usage?: ExtractionUsage;
  jobId?: number | null;
}

/** Records what a freshly computed value was computed from, so the next run can skip it. */
export function recordDerivation(db: Database.Database, params: RecordDerivationParams): void {
  upsertDerivation(db, {
    entityType: params.entityType,
    entityId: params.entityId,
    kind: params.kind,
    sourceKey: params.key.sourceKey,
    recipeVersion: params.key.recipeVersion,
    // 'none' means no call was made at all. A call whose envelope did not
    // report a model is 'unknown' — recording it as 'none' would claim a
    // free deterministic derivation for something that may have cost money,
    // and break any query that filters on 'none' to isolate free rows.
    model: params.usage ? (params.usage.model ?? 'unknown') : 'none',
    costUsd: params.usage?.costUsd ?? 0,
    inputTokens: params.usage?.inputTokens ?? null,
    outputTokens: params.usage?.outputTokens ?? null,
    jobId: params.jobId ?? null,
  });
}
