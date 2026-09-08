import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { NotFoundError } from '../../db/errors.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import {
  acknowledgeNotification,
  listUnacknowledgedNotifications,
} from '../../db/repositories/notifications.js';
import type { EntityType } from '../../domain/entity-type.js';
import { formatNotificationLine } from '../../notify/terminal.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { parseEntityType, parsePositiveInt } from '../parsers.js';

export function registerEventsCommand(program: Command): void {
  program
    .command('events')
    .description('Show the audit trail for a company or role')
    .argument('<type>', 'Entity type (company|role)', parseEntityType)
    .argument('<id>', 'Entity id', parsePositiveInt)
    .action((type: EntityType, id: number) => {
      const db = getDb();
      const events = listEventsForEntity(db, type, id);
      if (events.length === 0) {
        console.log(`No events recorded for ${type} #${id}.`);
        return;
      }
      for (const event of events) {
        const context = event.context ? `  ${event.context}` : '';
        console.log(`${event.occurred_at}  ${event.type}${context}`);
      }
    });

  const inbox = program.command('inbox').description('Show notifications waiting for your attention');
  inbox.action(() => {
    const db = getDb();
    const notifications = listUnacknowledgedNotifications(db);
    if (notifications.length === 0) {
      console.log('Inbox is empty.');
      return;
    }
    for (const notification of notifications) {
      console.log(formatNotificationLine(notification));
    }
  });

  inbox
    .command('ack')
    .description('Acknowledge a notification')
    .argument('<notificationId>', 'Notification id', parsePositiveInt)
    .action((id: number) => {
      reportKnownErrors([NotFoundError], () => {
        const db = getDb();
        const notification = acknowledgeNotification(db, id);
        console.log(`Notification #${notification.id} acknowledged`);
      });
    });
}
