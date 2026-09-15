import type Database from 'better-sqlite3';
import { recordEvent } from '../../db/repositories/events.js';
import { createNotification } from '../../db/repositories/notifications.js';
import type { JobRecord } from '../../db/repositories/jobs.js';
import { formatNotificationLine } from '../../notify/terminal.js';
import { deliverMacosNotification } from '../../notify/macos.js';
import { loadSettings, NOTIFICATION_CHANNELS, type NotificationChannel } from '../../config/settings.js';
import { oneOfOr } from '../../lib/config-coerce.js';
import { tryRecordOperationalLog } from '../../db/repositories/operational-logs.js';

export interface NotificationJobPayload {
  entityType: string;
  entityId: number | null;
  eventType: string;
  context?: unknown;
  message: string;
  /** Overrides `settings.notification_channel` for this one notification. */
  channel?: NotificationChannel;
}

/**
 * Where to deliver, from the payload if it says and the setting otherwise.
 *
 * Both halves are coerced. The payload is `JSON.parse` output despite its
 * type, so a producer typo or an older queued row saying `"slack"` would
 * otherwise match neither branch below: a `notifications` row with
 * `delivered_at` set, nothing printed, no banner, and no log.
 *
 * The settings read is wrapped because `loadJsonConfig` throws by design on
 * a JSON typo, and it happens *before* the event and notification rows are
 * written. Unguarded, a cosmetic delivery preference could fail the job
 * through every retry and destroy the durable record the handler exists to
 * create — the same shape as the Step 35 finding.
 */
function resolveChannel(fromPayload: NotificationChannel | undefined): NotificationChannel {
  if (fromPayload !== undefined) return oneOfOr(fromPayload, NOTIFICATION_CHANNELS, 'terminal');
  try {
    return loadSettings().notification_channel;
  } catch {
    return 'terminal';
  }
}

/**
 * Records the audit event this notification is about, then the notification
 * itself, then delivers it. Producers (refresh, discover, ...) enqueue one
 * of these instead of writing events/notifications directly, so delivery
 * stays decoupled from whoever detected the thing worth notifying about.
 */
export async function handleNotificationJob(db: Database.Database, job: JobRecord): Promise<void> {
  const payload = JSON.parse(job.payload) as NotificationJobPayload;
  const channel = resolveChannel(payload.channel);

  const event = recordEvent(db, {
    entityType: payload.entityType,
    entityId: payload.entityId,
    type: payload.eventType,
    context: payload.context,
  });

  const notification = createNotification(db, {
    eventId: event.id,
    message: payload.message,
    channel,
    deliveredAt: new Date().toISOString(),
  });

  if (channel === 'terminal' || channel === 'both') {
    console.log(formatNotificationLine(notification));
  }

  if (channel === 'macos' || channel === 'both') {
    // Awaited but never allowed to fail the job: the durable record is the
    // `notifications` row written above, and losing a queue item because a
    // banner could not be drawn would trade it for the ephemeral one.
    const result = await deliverMacosNotification(payload.message);
    if (!result.delivered) {
      tryRecordOperationalLog(db, {
        severity: 'warn',
        outcome: 'failed',
        component: 'notify',
        action: 'macos-banner',
        jobId: job.id,
        context: { reason: result.reason },
      });
    }
  }
}
