import type Database from 'better-sqlite3';
import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { enqueueJob, getJobById } from '../../db/repositories/jobs.js';
import { getRoleById } from '../../db/repositories/roles.js';
import { getFreshCompanyTips, getLatestRoleTips, type TipsSource } from '../../db/repositories/tips.js';
import { COMPANY_TIPS_FRESHNESS_DAYS } from '../../daemon/handlers/tips.js';
import { ensureDaemonRunning } from '../../lib/daemon-control.js';
import { parsePositiveInt } from '../parsers.js';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 300_000; // real research runs, observed up to ~110s for a single call

function printSources(sourcesJson: string): void {
  const sources = JSON.parse(sourcesJson) as TipsSource[];
  if (sources.length === 0) {
    console.log('Sources: (none cited)');
    return;
  }
  console.log('Sources:');
  for (const source of sources) {
    console.log(`  - ${source.title || source.url}: ${source.url}`);
  }
}

function printTips(
  companyId: number,
  roleTipsContent: string,
  roleTipsSourcesJson: string,
  db: Database.Database,
): void {
  const companyTips = getFreshCompanyTips(db, companyId, COMPANY_TIPS_FRESHNESS_DAYS);
  if (companyTips) {
    console.log('\n## Company tips\n');
    console.log(companyTips.content);
    printSources(companyTips.sources);
  }

  console.log('\n## Role-specific tips\n');
  console.log(roleTipsContent);
  printSources(roleTipsSourcesJson);
}

export function registerTipsCommand(program: Command): void {
  program
    .command('tips')
    .description('Show cited tips on how to approach a role, researched from multiple sources')
    .argument('<roleId>', 'Role id', parsePositiveInt)
    .option('--refresh', 'Re-research even if tips were already generated for this role')
    .action(async (roleId: number, opts: { refresh?: boolean }) => {
      const db = getDb();
      const role = getRoleById(db, roleId);
      if (!role) {
        console.error(`Role #${roleId} not found`);
        process.exitCode = 1;
        return;
      }
      if (role.company_id == null) {
        console.error(
          `Role #${roleId}'s company hasn't been resolved yet — check \`cm roles show ${roleId}\` and try again once enrichment finishes.`,
        );
        process.exitCode = 1;
        return;
      }

      const existing = getLatestRoleTips(db, roleId);
      if (existing && !opts.refresh) {
        console.log(`(showing previously generated tips from ${existing.generated_at} — pass --refresh to re-research)`);
        printTips(role.company_id, existing.content, existing.sources, db);
        return;
      }

      console.log('Researching tips — this can take a while (multiple sources, cited)...');
      const previousRoleTipsId = existing?.id;

      const job = enqueueJob(db, { topic: 'tips', payload: { kind: 'role-tips', roleId } });
      ensureDaemonRunning();

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let roleTips = getLatestRoleTips(db, roleId);
      while ((!roleTips || roleTips.id === previousRoleTipsId) && Date.now() < deadline) {
        const currentJob = getJobById(db, job.id);
        if (currentJob?.status === 'failed') {
          console.error(`Tips research failed: ${currentJob.error ?? 'unknown error'}`);
          process.exitCode = 1;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        roleTips = getLatestRoleTips(db, roleId);
      }

      if (!roleTips || roleTips.id === previousRoleTipsId) {
        console.error(`Timed out waiting for tips. Check \`cm events role ${roleId}\` for details, or try again.`);
        process.exitCode = 1;
        return;
      }

      printTips(role.company_id, roleTips.content, roleTips.sources, db);
    });
}
