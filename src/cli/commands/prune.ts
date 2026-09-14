import type { Command } from 'commander';
import { loadSettings } from '../../config/settings.js';
import { getDb } from '../../db/client.js';
import { pruneOldRecords } from '../../db/prune.js';
import { parsePositiveInt } from '../parsers.js';

export function registerPruneCommand(program: Command): void {
  program
    .command('prune')
    .description('Delete old diagnostics: operational logs and completed jobs')
    .option('--older-than <days>', 'Retention in days (default: settings.prune_after_days)', parsePositiveInt)
    .option('--dry-run', 'Report what would be deleted without deleting it')
    .option('--vacuum', 'Also return the freed space to the filesystem (rewrites the database)')
    .action((opts: { olderThan?: number; dryRun?: boolean; vacuum?: boolean }) => {
      const days = opts.olderThan ?? loadSettings().prune_after_days;
      const result = pruneOldRecords(getDb(), days, {
        dryRun: Boolean(opts.dryRun),
        vacuum: Boolean(opts.vacuum) && !opts.dryRun,
      });

      const verb = opts.dryRun ? 'Would delete' : 'Deleted';
      console.log(`${verb} records older than ${days} day(s) (before ${result.cutoffIso}):`);
      console.log(`  operational logs: ${result.operationalLogs}`);
      console.log(`  completed jobs:   ${result.doneJobs}`);
      // Stated every time, not only on --dry-run: the obvious worry about a
      // command like this is what it might have taken with it, and the
      // answer should not require reading the source.
      console.log('Kept: model spend, derivations, page snapshots, events, and any job not yet done.');
      // Named precisely, because "nothing else is touched" would be untrue:
      // removing a job nulls `job_id` on the derivation, log and ledger rows
      // that referenced it. Their values are unchanged; only the link goes.
      console.log('Removing a job clears the job link on related logs, derivations and spend rows (values are kept).');
      if (!opts.dryRun && !opts.vacuum && result.operationalLogs + result.doneJobs > 0) {
        // Otherwise "Deleted 40000" followed by an unchanged file size reads
        // as the command having done nothing.
        console.log('The database file does not shrink on its own — rerun with --vacuum to reclaim the space.');
      }
    });
}
