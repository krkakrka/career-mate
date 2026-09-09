import { ENTITY_TYPES, type EntityType } from './entity-type.js';

export interface JobEntity {
  entityType: EntityType;
  entityId: number;
}

/**
 * Infers which entity a job's payload is about, purely from its shape —
 * every job payload across every topic carries either an explicit
 * entityType/entityId pair (notification jobs) or a roleId/companyId field
 * (enrichment, refresh, discovery, tips) — so operational-log correlation
 * doesn't need each handler to opt in individually. Returns undefined for
 * a payload shape this can't place (nothing to correlate, not an error).
 */
export function inferJobEntity(payload: unknown): JobEntity | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;

  if (
    typeof record.entityType === 'string' &&
    (ENTITY_TYPES as readonly string[]).includes(record.entityType) &&
    typeof record.entityId === 'number'
  ) {
    return { entityType: record.entityType as EntityType, entityId: record.entityId };
  }
  if (typeof record.roleId === 'number') return { entityType: 'role', entityId: record.roleId };
  if (typeof record.companyId === 'number') return { entityType: 'company', entityId: record.companyId };
  return undefined;
}
