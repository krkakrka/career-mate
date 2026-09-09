import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { listCompanies } from '../../db/repositories/companies.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { ensureDaemonRunning } from '../../lib/daemon-control.js';

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Scan tracked companies for new roles matching your preferences')
    .action(() => {
      const db = getDb();
      const companies = listCompanies(db);
      if (companies.length === 0) {
        console.log('No tracked companies to scan. Add one with `cm companies add <url>` first.');
        return;
      }

      // Fire-and-forget, same as `roles add`/`companies add` and `cm
      // refresh`: enqueue and let the daemon work through it in the
      // background. Check `cm inbox` for what was found, or `cm worker
      // status` for progress.
      for (const company of companies) {
        enqueueJob(db, { topic: 'discovery', payload: { kind: 'company-discover', companyId: company.id } });
      }
      ensureDaemonRunning();
      console.log(
        `Scanning ${companies.length} tracked compan${companies.length === 1 ? 'y' : 'ies'} for new roles in the background (one web search per company) — check \`cm inbox\` for what's found.`,
      );
    });
}
