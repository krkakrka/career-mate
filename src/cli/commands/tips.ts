import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerTipsCommand(program: Command): void {
  program
    .command('tips <roleId>')
    .description('Generate cited tips on how to approach a role, researched from multiple sources')
    .action(notImplemented('tips'));
}
