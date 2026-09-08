import type Database from 'better-sqlite3';
import type { EntityType } from '../../domain/entity-type.js';

export interface EventRecord {
  id: number;
  entity_type: string;
  entity_id: number | null;
  type: string;
  context: string | null;
  occurred_at: string;
}

export interface RecordEventParams {
  entityType: string;
  entityId: number | null;
  type: string;
  /** Serialized to JSON. Pass a plain object/array/primitive, not a pre-stringified string. */
  context?: unknown;
}

export function recordEvent(db: Database.Database, params: RecordEventParams): EventRecord {
  const contextJson = params.context !== undefined ? JSON.stringify(params.context) : null;
  const result = db
    .prepare('INSERT INTO events (entity_type, entity_id, type, context) VALUES (?, ?, ?, ?)')
    .run(params.entityType, params.entityId, params.type, contextJson);

  const event = getEventById(db, result.lastInsertRowid as number);
  if (!event) throw new Error('Event vanished immediately after insert');
  return event;
}

export function getEventById(db: Database.Database, id: number): EventRecord | undefined {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRecord | undefined;
}

export function listEventsForEntity(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
): EventRecord[] {
  return db
    .prepare('SELECT * FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY occurred_at ASC, id ASC')
    .all(entityType, entityId) as EventRecord[];
}
