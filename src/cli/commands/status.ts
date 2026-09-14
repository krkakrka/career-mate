import type { Command } from 'commander';
import { loadSettings } from '../../config/settings.js';
import { getDb } from '../../db/client.js';
import { formatDuration } from './logs.js';
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

      if (digest.slowestActions.length > 0) {
        console.log('\nSlowest actions (7d):');
        for (const slow of digest.slowestActions) {
          console.log(`  ${formatDuration(slow.durationMs).padStart(7)}  ${slow.component}.${slow.action}  ${slow.occurredAt}`);
        }
      }

      console.log('\nUsage by surface (7d):');
      for (const surface of digest.surfaceUsage.surfaces) {
        if (surface.calls === 0 && surface.modelCalls === 0) {
          // Printed rather than omitted: a surface disappearing from the
          // list reads as "never used" and as "not installed" identically.
          console.log(`  ${surface.surface.padEnd(4)}  not used yet`);
          continue;
        }
        const failures = surface.failures > 0 ? `, ${surface.failures} failed` : '';
        const timing =
          surface.medianMs === null
            ? 'no timed calls'
            : `median ${formatDuration(surface.medianMs)}, p90 ${formatDuration(surface.p90Ms!)}`;
        // Startup is called out separately because it is the whole story
        // here: a CLI command does 5 ms of work and costs a third of a
        // second, while the long-lived MCP server pays this once.
        const startup =
          surface.medianStartupMs === null ? '' : `  ·  +${formatDuration(surface.medianStartupMs)} startup/call`;
        console.log(
          `  ${surface.surface.padEnd(4)}  ${surface.calls} call(s)${failures}  ·  ${timing}${startup}  ·  ` +
            `$${surface.spendUsd.toFixed(2)} over ${surface.modelCalls} model call(s)`,
        );
      }
      if (digest.surfaceUsage.unattributedModelCalls > 0) {
        // Never folded into a surface: the point of this block is choosing
        // which one to keep using, and a total that absorbs unknowns is
        // worse than one that admits them.
        console.log(
          `  unattributed: $${digest.surfaceUsage.unattributedSpendUsd.toFixed(2)} over ` +
            `${digest.surfaceUsage.unattributedModelCalls} model call(s) (daemon-initiated, or predating job origins)`,
        );
      }

      const { last7Days, last30Days } = digest.modelSpend;
      console.log(
        `\nModel spend: $${last7Days.totalUsd.toFixed(2)} over ${last7Days.calls} call(s) in 7d  ·  ` +
          `$${last30Days.totalUsd.toFixed(2)} over ${last30Days.calls} call(s) in 30d`,
      );
    });
}
