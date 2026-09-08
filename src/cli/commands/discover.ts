import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Scan career pages of tracked companies for new roles matching your preferences')
    .action(notImplemented('discover'));
}
