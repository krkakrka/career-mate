import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerEventsCommand(program: Command): void {
  program
    .command('events <entityId>')
    .description('Show the audit trail for a company or role')
    .action(notImplemented('events'));

  const inbox = program.command('inbox').description('Show notifications waiting for your attention');
  inbox.action(notImplemented('inbox'));

  inbox
    .command('ack <notificationId>')
    .description('Acknowledge a notification')
    .action(notImplemented('inbox ack'));
}
