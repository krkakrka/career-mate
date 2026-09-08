import type { NotificationRecord } from '../db/repositories/notifications.js';

export function formatNotificationLine(notification: NotificationRecord): string {
  const status = notification.acknowledged_at ? '[read]' : '[new]';
  return `#${notification.id} ${status} ${notification.message}`;
}
