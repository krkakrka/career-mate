import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerCompaniesCommand(program: Command): void {
  const companies = program.command('companies').description('Manage tracked companies');

  companies
    .command('add <url>')
    .description('Add a new company by URL')
    .action(notImplemented('companies add'));

  companies
    .command('list')
    .description('List tracked companies')
    .action(notImplemented('companies list'));

  companies
    .command('show <id>')
    .description('Show company detail')
    .action(notImplemented('companies show'));

  companies
    .command('set-preference <id> <rating>')
    .description('Set your manual preference rating for a company (-2 to 2)')
    .action(notImplemented('companies set-preference'));

  companies
    .command('set-connections <id> <note>')
    .description('Record a personal connection/referral note for a company')
    .action(notImplemented('companies set-connections'));
}
