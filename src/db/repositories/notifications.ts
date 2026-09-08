import type Database from 'better-sqlite3';
import { NotFoundError } from '../errors.js';

export interface NotificationRecord {
  id: number;
  event_id: number;
  channel: string | null;
  message: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
}

export interface CreateNotificationParams {
  eventId: number;
  message: string;
  channel?: string | null;
  deliveredAt?: string | null;
}

export function createNotification(
  db: Database.Database,
  params: CreateNotificationParams,
): NotificationRecord {
  const result = db
    .prepare('INSERT INTO notifications (event_id, channel, message, delivered_at) VALUES (?, ?, ?, ?)')
    .run(params.eventId, params.channel ?? null, params.message, params.deliveredAt ?? null);

  const notification = getNotificationById(db, result.lastInsertRowid as number);
  if (!notification) throw new Error('Notification vanished immediately after insert');
  return notification;
}

export function getNotificationById(db: Database.Database, id: number): NotificationRecord | undefined {
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRecord | undefined;
}

export function listUnacknowledgedNotifications(db: Database.Database): NotificationRecord[] {
  return db
    .prepare('SELECT * FROM notifications WHERE acknowledged_at IS NULL ORDER BY id ASC')
    .all() as NotificationRecord[];
}

export function acknowledgeNotification(db: Database.Database, id: number): NotificationRecord {
  const notification = getNotificationById(db, id);
  if (!notification) throw new NotFoundError(`Notification #${id} not found`);

  db.prepare(
    "UPDATE notifications SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(id);

  const updated = getNotificationById(db, id);
  if (!updated) throw new Error('Notification vanished immediately after update');
  return updated;
}
