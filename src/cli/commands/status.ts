import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show a pipeline health digest: counts per stage, stale roles, overdue follow-ups')
    .action(notImplemented('status'));
}
