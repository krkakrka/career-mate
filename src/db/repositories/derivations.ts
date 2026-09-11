import type Database from 'better-sqlite3';
import type { EntityType } from '../../domain/entity-type.js';

/**
 * The derived field groups the system tracks. One row per (entity, kind),
 * so "is this group stale?" is a single lookup.
 */
export const DERIVATION_KINDS = [
  'company_structural',
  'role_structural',
  'role_research',
  'company_research',
  'company_wlb',
  'role_closure',
  'tips_company',
  'tips_role',
  // Not a field group anything renders a `(stale)` marker for — recorded
  // so that `cm status`'s model spend covers discover's web searches too,
  // rather than silently understating what the tool costs.
  'company_discover',
] as const;

export type DerivationKind = (typeof DERIVATION_KINDS)[number];

/** What a deterministic rule records instead of a model name. */
export const NO_MODEL = 'none';

export interface DerivationRecord {
  id: number;
  entity_type: EntityType;
  entity_id: number;
  kind: DerivationKind;
  source_key: string;
  recipe_version: string;
  model: string;
  cost_usd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  computed_at: string;
  job_id: number | null;
}

export interface UpsertDerivationParams {
  entityType: EntityType;
  entityId: number;
  kind: DerivationKind;
  sourceKey: string;
  recipeVersion: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  jobId?: number | null;
}

/**
 * Records what a derived value was computed from, replacing any previous
 * record for the same (entity, kind). `computed_at` is refreshed on every
 * upsert — including one that writes the same keys again — because it
 * answers "when did we last confirm this", not "when did it last change".
 */
export function upsertDerivation(db: Database.Database, params: UpsertDerivationParams): DerivationRecord {
  db.prepare(
    `INSERT INTO derivations
       (entity_type, entity_id, kind, source_key, recipe_version, model, cost_usd, input_tokens, output_tokens, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity_type, entity_id, kind) DO UPDATE SET
       source_key = excluded.source_key,
       recipe_version = excluded.recipe_version,
       model = excluded.model,
       cost_usd = excluded.cost_usd,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       computed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       job_id = excluded.job_id`,
  ).run(
    params.entityType,
    params.entityId,
    params.kind,
    params.sourceKey,
    params.recipeVersion,
    params.model ?? NO_MODEL,
    params.costUsd ?? 0,
    params.inputTokens ?? null,
    params.outputTokens ?? null,
    params.jobId ?? null,
  );

  const derivation = getDerivation(db, params.entityType, params.entityId, params.kind);
  if (!derivation) throw new Error('Derivation vanished immediately after upsert');
  return derivation;
}

export function getDerivation(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
): DerivationRecord | undefined {
  return db
    .prepare('SELECT * FROM derivations WHERE entity_type = ? AND entity_id = ? AND kind = ?')
    .get(entityType, entityId, kind) as DerivationRecord | undefined;
}

export function listDerivationsForEntity(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
): DerivationRecord[] {
  return db
    .prepare('SELECT * FROM derivations WHERE entity_type = ? AND entity_id = ? ORDER BY kind ASC')
    .all(entityType, entityId) as DerivationRecord[];
}
