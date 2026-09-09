import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { DuplicateError, NotFoundError } from '../../db/errors.js';
import { listInterviewNotes } from '../../db/repositories/interview-notes.js';
import { listRecruiterContacts } from '../../db/repositories/recruiter-contacts.js';
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
import { enqueueEnrichment } from '../enqueue-enrichment.js';
import { reportKnownErrors } from '../handle-known-errors.js';
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
  console.log(`Company: ${role.company_id !== null ? `#${role.company_id}` : '(resolving in the background)'}`);
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
    .description(
      'Add a new role by URL. Omit --company to have it resolved automatically from the role page.',
    )
    .argument('<url>', 'Role URL', parseHttpUrl)
    .option('--company <id>', 'Company id this role belongs to (auto-resolved from the page if omitted)', parsePositiveInt)
    .option('--force', 'Add even if it looks like a duplicate of an existing role')
    .action((url: string, opts: { company?: number; force?: boolean }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const role = createRole(db, { companyId: opts.company ?? null, url, force: opts.force ?? false });
        enqueueEnrichment(db, { kind: 'role-structural', roleId: role.id });
        const companyNote =
          role.company_id !== null ? `company #${role.company_id}` : 'company resolving in the background';
        console.log(`Added role #${role.id} (${companyNote}): ${role.url}`);
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
        const companyLabel = role.company_id !== null ? `company#${role.company_id}` : 'company(pending)';
        const priorityLabel = role.priority_score != null ? `priority=${role.priority_score.toFixed(2)}` : 'priority=?';
        console.log(
          `#${role.id}  ${role.title ?? '(untitled)'}  ${companyLabel}  status=${role.status}  ${priorityLabel}  ${role.url}`,
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

      const contacts = listRecruiterContacts(db, { roleId: id });
      if (contacts.length > 0) {
        console.log('\nRecruiter contacts:');
        for (const contact of contacts) {
          const responded = contact.responded_at ? `  (responded ${contact.responded_at})` : '  (no response yet)';
          console.log(`  ${contact.contacted_at}  ${contact.recruiter_name}${responded}`);
        }
      }

      const notes = listInterviewNotes(db, id);
      if (notes.length > 0) {
        console.log('\nInterview notes:');
        for (const note of notes) {
          console.log(`  ${note.occurred_at}  [${note.stage}] ${note.notes}`);
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
    .command('rerun-enrichment')
    .description('Manually re-run structural-fetch enrichment for a role')
    .argument('<id>', 'Role id', parsePositiveInt)
    .action((id: number) => {
      const db = getDb();
      const role = getRoleById(db, id);
      if (!role) {
        console.error(`Role #${id} not found`);
        process.exitCode = 1;
        return;
      }
      enqueueEnrichment(db, { kind: 'role-structural', roleId: id });
      console.log(`Re-enrichment queued for role #${id}.`);
    });
}
