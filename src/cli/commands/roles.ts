import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { DuplicateError, NotFoundError } from '../../db/errors.js';
import {
  createRole,
  getRoleById,
  getStatusHistory,
  listRoles,
  setReapplyAfter,
  setStatus,
  type Role,
} from '../../db/repositories/roles.js';
import { ROLE_STATUSES } from '../../domain/role-status.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { notImplemented } from '../not-implemented.js';
import {
  parseDate,
  parseHttpUrl,
  parsePositiveInt,
  parseRoleStatus,
  parseSortField,
} from '../parsers.js';

const KNOWN_ERRORS = [DuplicateError, NotFoundError];

function printRoleDetail(role: Role): void {
  console.log(`#${role.id} ${role.title ?? '(untitled — not yet fetched)'}`);
  console.log(`Company: #${role.company_id}`);
  console.log(`URL: ${role.url}`);
  console.log(`Status: ${role.status} (since ${role.status_changed_at})`);
  console.log(`Reapply after: ${role.reapply_after ?? '(none)'}`);
  console.log(`Salary: ${role.salary_min ?? '?'} - ${role.salary_max ?? '?'}`);
  console.log(`Equity: ${role.equity ?? '(unknown)'}`);
  console.log(`Remote/EU: ${role.remote_eu ?? '(unknown)'}`);
  console.log(`Priority score: ${role.priority_score ?? '(not yet scored)'}`);
  console.log(`Created: ${role.created_at}`);
}

export function registerRolesCommand(program: Command): void {
  const roles = program.command('roles').description('Manage tracked roles');

  roles
    .command('add')
    .description('Add a new role by URL')
    .argument('<url>', 'Role URL', parseHttpUrl)
    .requiredOption('--company <id>', 'Company id this role belongs to', parsePositiveInt)
    .option('--force', 'Add even if it looks like a duplicate of an existing role')
    .action((url: string, opts: { company: number; force?: boolean }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const role = createRole(db, { companyId: opts.company, url, force: opts.force ?? false });
        console.log(`Added role #${role.id} for company #${role.company_id}: ${role.url}`);
      });
    });

  roles
    .command('list')
    .description('List tracked roles (defaults to active statuses only — pass --status to see others)')
    .option(
      '--status <status>',
      `Filter by status (${ROLE_STATUSES.join('|')})`,
      parseRoleStatus,
    )
    .option('--company <id>', 'Filter by company id', parsePositiveInt)
    .option('--sort <field>', 'Sort field (priority|updated|company)', parseSortField)
    .action((opts: { status?: string; company?: number; sort?: 'priority' | 'updated' | 'company' }) => {
      const db = getDb();
      const rows = listRoles(db, {
        status: opts.status as Role['status'] | undefined,
        companyId: opts.company,
        sort: opts.sort,
      });
      if (rows.length === 0) {
        console.log('No roles match.');
        return;
      }
      for (const role of rows) {
        console.log(
          `#${role.id}  ${role.title ?? '(untitled)'}  company#${role.company_id}  status=${role.status}  ${role.url}`,
        );
      }
    });

  roles
    .command('show')
    .description('Show full role detail')
    .argument('<id>', 'Role id', parsePositiveInt)
    .action((id: number) => {
      const db = getDb();
      const role = getRoleById(db, id);
      if (!role) {
        console.error(`Role #${id} not found`);
        process.exitCode = 1;
        return;
      }
      printRoleDetail(role);

      const history = getStatusHistory(db, id);
      if (history.length > 0) {
        console.log('\nStatus history:');
        for (const entry of history) {
          const note = entry.context ? `  (${entry.context})` : '';
          console.log(`  ${entry.changed_at}  ${entry.from_status ?? '(none)'} -> ${entry.to_status}${note}`);
        }
      }
    });

  roles
    .command('set-status')
    .description(`Change a role status (${ROLE_STATUSES.join('|')})`)
    .argument('<id>', 'Role id', parsePositiveInt)
    .argument('<status>', 'New status', parseRoleStatus)
    .option('--note <note>', 'Context note for this status change')
    .action((id: number, status: Role['status'], opts: { note?: string }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const role = setStatus(db, id, status, opts.note);
        const reapplyNote = role.reapply_after ? ` (reapply after ${role.reapply_after})` : '';
        console.log(`Role #${role.id} status set to ${role.status}${reapplyNote}`);
      });
    });

  roles
    .command('set-reapply')
    .description('Set/override the reapply-after date for a role')
    .argument('<id>', 'Role id', parsePositiveInt)
    .argument('<date>', 'Reapply-after date, YYYY-MM-DD', parseDate)
    .action((id: number, isoDate: string) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const role = setReapplyAfter(db, id, isoDate);
        console.log(`Role #${role.id} reapply-after set to ${role.reapply_after}`);
      });
    });

  roles
    .command('rerun-enrichment <id>')
    .description('Manually re-run enrichment for a role')
    .action(notImplemented('roles rerun-enrichment'));
}
