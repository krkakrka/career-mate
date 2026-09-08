import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command('daemon').description('Manage the background worker daemon');

  daemon.command('start').description('Start the daemon explicitly').action(notImplemented('daemon start'));
  daemon.command('stop').description('Stop the running daemon').action(notImplemented('daemon stop'));
  daemon.command('status').description('Show whether the daemon is running').action(notImplemented('daemon status'));
}
