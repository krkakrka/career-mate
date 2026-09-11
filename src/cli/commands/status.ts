import type { Command } from 'commander';
import { loadSettings } from '../../config/settings.js';
import { getDb } from '../../db/client.js';
import { buildPipelineDigest, type ReapplyRole, type StaleRole } from '../../reporting/pipeline-digest.js';
import { ROLE_STATUSES } from '../../domain/role-status.js';

function printRoleLine(role: StaleRole | ReapplyRole, extra: string): void {
  console.log(`  #${role.id}  ${role.title ?? '(untitled)'}  ${extra}  ${role.url}`);
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show a pipeline health digest: counts per stage, stale roles, overdue follow-ups')
    .action(() => {
      const db = getDb();
      const settings = loadSettings();
      const digest = buildPipelineDigest(db, settings);

      console.log('Pipeline status:');
      for (const status of ROLE_STATUSES) {
        console.log(`  ${status}: ${digest.statusCounts[status]}`);
      }

      console.log(`\nStale roles (no status change in ${settings.stale_days}+ days): ${digest.staleRoles.length}`);
      for (const role of digest.staleRoles) printRoleLine(role, `${role.status} since ${role.statusChangedAt}`);

      console.log(
        `\nRecruiter contacts overdue for follow-up (${settings.recruiter_nudge_days}+ days, no response): ${digest.overdueRecruiterContacts.length}`,
      );
      for (const contact of digest.overdueRecruiterContacts) {
        console.log(`  #${contact.id}  ${contact.recruiter_name}  role #${contact.role_id}  contacted ${contact.contacted_at}`);
      }

      console.log(`\nReady to reapply: ${digest.reapplyReady.length}`);
      for (const role of digest.reapplyReady) printRoleLine(role, `reapply_after ${role.reapplyAfter}`);

      console.log(`\nReapply cooldown still active: ${digest.reapplyUpcoming.length}`);
      for (const role of digest.reapplyUpcoming) printRoleLine(role, `reapply_after ${role.reapplyAfter}`);

      const { last7Days, last30Days } = digest.modelSpend;
      console.log(
        `\nModel spend: $${last7Days.totalUsd.toFixed(2)} over ${last7Days.calls} call(s) in 7d  ·  ` +
          `$${last30Days.totalUsd.toFixed(2)} over ${last30Days.calls} call(s) in 30d`,
      );
    });
}
