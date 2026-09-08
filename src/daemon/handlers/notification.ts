import type Database from 'better-sqlite3';
import { recordEvent } from '../../db/repositories/events.js';
import { createNotification } from '../../db/repositories/notifications.js';
import type { JobRecord } from '../../db/repositories/jobs.js';
import { formatNotificationLine } from '../../notify/terminal.js';

export interface NotificationJobPayload {
  entityType: string;
  entityId: number | null;
  eventType: string;
  context?: unknown;
  message: string;
  channel?: 'terminal' | 'macos';
}

/**
 * Records the audit event this notification is about, then the notification
 * itself, then delivers it. Producers (refresh, discover, ...) enqueue one
 * of these instead of writing events/notifications directly, so delivery
 * stays decoupled from whoever detected the thing worth notifying about.
 */
export function handleNotificationJob(db: Database.Database, job: JobRecord): void {
  const payload = JSON.parse(job.payload) as NotificationJobPayload;

  const event = recordEvent(db, {
    entityType: payload.entityType,
    entityId: payload.entityId,
    type: payload.eventType,
    context: payload.context,
  });

  const notification = createNotification(db, {
    eventId: event.id,
    message: payload.message,
    channel: payload.channel ?? 'terminal',
    deliveredAt: new Date().toISOString(),
  });

  if ((payload.channel ?? 'terminal') === 'terminal') {
    console.log(formatNotificationLine(notification));
  }
  // macOS banner delivery arrives in a later step, alongside the first
  // producer (refresh/discover) that actually wants it.
}
