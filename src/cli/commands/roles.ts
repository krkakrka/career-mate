import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { ensureDaemonRunning } from '../../lib/daemon-control.js';
import { DuplicateError, NotFoundError } from '../../db/errors.js';
import { listInterviewNotes } from '../../db/repositories/interview-notes.js';
import { listRecruiterContacts } from '../../db/repositories/recruiter-contacts.js';
import {
  createRole,
  findRoleByUrl,
  getRoleById,
  getStatusHistory,
  listRoles,
  setReapplyAfter,
  setStatus,
  type Role,
} from '../../db/repositories/roles.js';
import {
  currentRecipeVersions,
  markersByKind,
  recomputeFloorMs,
  roleFieldGroupStatus,
} from '../../derive/view-staleness.js';
import { loadPreferences } from '../../config/preferences.js';
import { loadScoringWeights } from '../../config/scoring.js';
import { ROLE_STATUSES } from '../../domain/role-status.js';
import { fetchApplicationForm } from '../../forms/index.js';
import { FetchError } from '../../pages/fetch.js';
import { renderForm } from './form-view.js';
import { scoreRole, scoreRoleWithConfig } from '../../scoring/priority.js';
import { roleStructuralPayload } from '../../domain/enrichment-payload.js';
import { enqueueEnrichment, enqueueRecomputesAndRun, queueRecomputes } from '../enqueue-enrichment.js';
import { reportKnownErrors, reportKnownErrorsAsync } from '../handle-known-errors.js';
import {
  parseDate,
  parseHttpUrl,
  parsePositiveInt,
  parseRoleStatus,
  parseSortField,
} from '../parsers.js';

const KNOWN_ERRORS = [DuplicateError, NotFoundError];

function suffix(marker: string | undefined): string {
  return marker ? `  ${marker}` : '';
}

function printRoleDetail(role: Role, markers: Map<string, string>, score: number): void {
  const structural = suffix(markers.get('role_structural'));
  const research = suffix(markers.get('role_research'));

  console.log(`#${role.id} ${role.title ?? '(untitled — not yet fetched)'}${structural}`);
  console.log(`Company: ${role.company_id !== null ? `#${role.company_id}` : '(resolving in the background)'}`);
  console.log(`URL: ${role.url}`);
  console.log(`Status: ${role.status} (since ${role.status_changed_at})`);
  console.log(`Reapply after: ${role.reapply_after ?? '(none)'}`);
  // The currency is printed only when recorded: model-researched figures
  // carry none, and appending a guess would make an unlabelled number look
  // labelled.
  const currency = role.salary_currency ? ` ${role.salary_currency}` : '';
  console.log(`Salary: ${role.salary_min ?? '?'} - ${role.salary_max ?? '?'}${currency}${research}`);
  console.log(`Equity: ${role.equity ?? '(unknown)'}${research}`);
  console.log(`Remote/EU: ${role.remote_eu ?? '(unknown)'}${research}`);
  console.log(`Priority score: ${score.toFixed(2)}`);
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
    .option('--force', 'Take a new snapshot of the page now, ignoring settings.page_refresh_days')
    .action((url: string, opts: { company?: number; force?: boolean }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();

        // Same URL already tracked (at this company, or anywhere if no
        // company was given): not an error, and not a second row. This
        // replaces the old `--force`-to-override duplicate block — `--force`
        // now means what it means everywhere else, take a new snapshot.
        const existing = findRoleByUrl(db, url, opts.company);
        if (existing) {
          if (!opts.force) {
            console.log(`Already tracking role #${existing.id}: ${existing.url}`);
            const groups = roleFieldGroupStatus(db, existing);
            enqueueRecomputesAndRun(db, 'role', existing.id, groups);
            printRoleDetail(existing, markersByKind(groups), scoreRoleWithConfig(db, existing));
            return;
          }
          enqueueEnrichment(db, roleStructuralPayload(existing.id, true));
          console.log(`Re-fetching role #${existing.id}: ${existing.url} (in the background)`);
          return;
        }

        const role = createRole(db, { companyId: opts.company ?? null, url });
        enqueueEnrichment(db, roleStructuralPayload(role.id, opts.force ?? false));
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
      // Loaded once for the whole list, not once per row.
      const weights = loadScoringWeights();
      const preferences = loadPreferences();
      const scored = rows.map((role) => ({ role, score: scoreRole(db, role, weights, preferences) }));
      // Sorting here rather than in SQL is what lets the score stay
      // unstored: a `set-preference` is reflected on the very next list,
      // with no recompute job in between.
      if (opts.sort === 'priority') scored.sort((a, b) => b.score - a.score);

      // Read once for the whole list, like the scoring weights above.
      const floorMs = recomputeFloorMs();
      const recipes = currentRecipeVersions();
      let anyOutstanding = false;
      for (const { role, score } of scored) {
        // Same lazy-recompute treatment as `companies list`: roles are the
        // view looked at most, so leaving it out meant the primary daily
        // list never showed a marker and never healed itself.
        const groups = roleFieldGroupStatus(db, role, recipes);
        anyOutstanding = queueRecomputes(db, 'role', role.id, groups, floorMs) || anyOutstanding;
        const marker = groups.some((group) => group.marker === '(stale)') ? '  (stale)' : '';

        const companyLabel = role.company_id !== null ? `company#${role.company_id}` : 'company(pending)';
        const priorityLabel = `priority=${score.toFixed(2)}`;
        console.log(
          `#${role.id}  ${role.title ?? '(untitled)'}  ${companyLabel}  status=${role.status}  ${priorityLabel}  ${role.url}${marker}`,
        );
      }
      // Once for the whole list, not once per row.
      if (anyOutstanding) ensureDaemonRunning();
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
      const groups = roleFieldGroupStatus(db, role);
      enqueueRecomputesAndRun(db, 'role', role.id, groups);
      printRoleDetail(role, markersByKind(groups), scoreRoleWithConfig(db, role));

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
    .command('form')
    .description("Show a posting's application form — how many questions, which are required, how much writing")
    .argument('<id>', 'Role id', parsePositiveInt)
    .action(async (id: number) => {
      // Async-aware, because Commander does not catch a rejected action: a
      // mistyped id would otherwise reach the user as a stack trace and be
      // recorded as an unhandled crash in `cm status`.
      await reportKnownErrorsAsync([...KNOWN_ERRORS, FetchError], async () => {
        const db = getDb();
        const role = getRoleById(db, id);
        if (!role) throw new NotFoundError(`No role #${id}`);

        const form = await fetchApplicationForm(role.url);
        if (!form) {
          // An ordinary answer, not a failure: most boards publish postings
          // without publishing their questions.
          console.log(`#${role.id} ${role.title ?? role.url}`);
          console.log('This board does not publish its application form. Open the posting to see it.');
          return;
        }

        const heading = `#${role.id} ${form.title ?? role.title ?? role.url}`;
        for (const line of renderForm(form, heading, role.url)) console.log(line);
      });
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
    .description('Deprecated alias for `cm roles add <url> --force`')
    .argument('<id>', 'Role id', parsePositiveInt)
    .action((id: number) => {
      const db = getDb();
      const role = getRoleById(db, id);
      if (!role) {
        console.error(`Role #${id} not found`);
        process.exitCode = 1;
        return;
      }
      enqueueEnrichment(db, roleStructuralPayload(id, true));
      console.log(`Re-enrichment queued for role #${id}.`);
      console.log(`Note: rerun-enrichment is deprecated — \`cm roles add ${role.url} --force\` does the same thing.`);
    });
}
