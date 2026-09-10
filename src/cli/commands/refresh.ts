import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { listRoleIdsNeedingClosureCheck } from '../../db/repositories/roles.js';
import { ensureDaemonRunning } from '../../lib/daemon-control.js';

export function registerRefreshCommand(program: Command): void {
  program
    .command('refresh')
    .description('Re-check tracked role URLs for closure and notify when one has closed')
    .option(
      '--force',
      'Fetch every role page again, ignoring the snapshot refresh window (settings.page_refresh_days.role)',
    )
    .action((options: { force?: boolean }) => {
      const db = getDb();
      const roleIds = listRoleIdsNeedingClosureCheck(db);
      if (roleIds.length === 0) {
        console.log('No active roles to check.');
        return;
      }

      // Fire-and-forget, same as `roles add`/`companies add`: enqueue and
      // let the daemon work through it in the background rather than
      // blocking this command on it. Check `cm inbox` for closures found,
      // or `cm worker status` for progress.
      for (const roleId of roleIds) {
        enqueueJob(db, {
          topic: 'refresh',
          payload: { kind: 'role-closure-check', roleId, force: options.force ?? false },
        });
      }
      ensureDaemonRunning();
      console.log(
        `Checking ${roleIds.length} role(s) for closure in the background — check \`cm inbox\` for any that closed.`,
      );
    });
}
