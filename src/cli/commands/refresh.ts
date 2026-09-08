import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerRefreshCommand(program: Command): void {
  program
    .command('refresh')
    .description('Re-check tracked role URLs for closure and notify on changes')
    .action(notImplemented('refresh'));
}
