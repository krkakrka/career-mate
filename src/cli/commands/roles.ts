import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerRolesCommand(program: Command): void {
  const roles = program.command('roles').description('Manage tracked roles');

  roles
    .command('add <url>')
    .description('Add a new role by URL')
    .option('--company <id>', 'Company id this role belongs to')
    .option('--force', 'Add even if it looks like a duplicate')
    .action(notImplemented('roles add'));

  roles
    .command('list')
    .description('List tracked roles')
    .option('--status <status>', 'Filter by status')
    .option('--company <id>', 'Filter by company id')
    .option('--sort <field>', 'Sort field (priority|updated|company)')
    .action(notImplemented('roles list'));

  roles
    .command('show <id>')
    .description('Show full role detail')
    .action(notImplemented('roles show'));

  roles
    .command('set-status <id> <status>')
    .description('Change a role status (new|todo|applied|interviewing|success|denied|skip)')
    .option('--note <note>', 'Context note for this status change')
    .action(notImplemented('roles set-status'));

  roles
    .command('set-reapply <id> <date>')
    .description('Set/override the reapply-after date for a role')
    .action(notImplemented('roles set-reapply'));

  roles
    .command('rerun-enrichment <id>')
    .description('Manually re-run enrichment for a role')
    .action(notImplemented('roles rerun-enrichment'));
}
