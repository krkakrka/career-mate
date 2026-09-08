import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerWorkerCommand(program: Command): void {
  const worker = program.command('worker').description('Inspect and control queued jobs');

  worker
    .command('drain')
    .description('Process all pending jobs now, without waiting for the daemon loop')
    .action(notImplemented('worker drain'));

  worker
    .command('status')
    .description('Show pending/running/failed job counts')
    .action(notImplemented('worker status'));
}
