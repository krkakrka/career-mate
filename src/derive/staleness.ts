import type Database from 'better-sqlite3';
import { getDerivation, type DerivationKind } from '../db/repositories/derivations.js';
import type { EntityType } from '../domain/entity-type.js';
import type { DerivationKey } from './keys.js';

export type StalenessReason = 'never-computed' | 'source-changed' | 'recipe-changed';

export interface StalenessVerdict {
  stale: boolean;
  reason: StalenessReason | null;
}

/**
 * Compares a derivation's recorded keys against the current ones.
 *
 * This is the whole staleness model: no dependency graph, no invalidation
 * cascade, no background sweep. A value is stale when the input it was
 * computed from is no longer the current input, or the recipe that
 * computed it has changed. Both are hash equality, evaluated on read.
 *
 * `current` being undefined means the input itself isn't available yet
 * (no snapshot for the page), which is not staleness — there is nothing to
 * compare against and nothing a recompute could do differently.
 */
export function isStale(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
  current: DerivationKey | undefined,
): StalenessVerdict {
  const derivation = getDerivation(db, entityType, entityId, kind);
  if (!derivation) return { stale: true, reason: 'never-computed' };
  if (!current) return { stale: false, reason: null };

  if (derivation.source_key !== current.sourceKey) return { stale: true, reason: 'source-changed' };
  if (derivation.recipe_version !== current.recipeVersion) return { stale: true, reason: 'recipe-changed' };
  return { stale: false, reason: null };
}

/**
 * Whether a completed derivation can be reused instead of recomputed — the
 * handler-side counterpart of `isStale`. Kept as its own function because
 * the two answer different questions: `isStale` asks "should the reader
 * see a marker", this asks "may I skip the model call".
 */
export function isFresh(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
  current: DerivationKey,
): boolean {
  const derivation = getDerivation(db, entityType, entityId, kind);
  return (
    derivation !== undefined &&
    derivation.source_key === current.sourceKey &&
    derivation.recipe_version === current.recipeVersion
  );
}
