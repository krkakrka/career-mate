import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { listOperationalLogs, type LogSeverity, type OperationalLogFilters } from '../../db/repositories/operational-logs.js';
import { parseEntityType, parsePositiveInt } from '../parsers.js';

function printLog(log: ReturnType<typeof listOperationalLogs>[number]): void {
  const correlation = [log.job_id != null ? `job=#${log.job_id}` : '', log.entity_type ? `${log.entity_type}=#${log.entity_id}` : '']
    .filter(Boolean)
    .join(' ');
  console.log(`${log.id}  ${log.occurred_at}  ${log.severity}/${log.outcome}  ${log.component}.${log.action}${correlation ? `  ${correlation}` : ''}`);
  if (log.context) console.log(`  context: ${log.context}`);
  if (log.error) console.log(`  error: ${log.error}`);
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Inspect durable operational diagnostics')
    .option('--severity <severity>', 'Filter by severity (debug|info|warn|error)')
    .option('--component <component>', 'Filter by component')
    .option('--action <action>', 'Filter by action')
    .option('--entity <type>', 'Filter by entity type (company|role)', parseEntityType)
    .option('--id <id>', 'Entity id (requires --entity)', parsePositiveInt)
    .option('--job <id>', 'Filter by job id', parsePositiveInt)
    .option('--limit <count>', 'Maximum rows (default 100)', parsePositiveInt)
    .option('--follow', 'Continue printing new records')
    .action(async (opts: { severity?: LogSeverity; component?: string; action?: string; entity?: string; id?: number; job?: number; limit?: number; follow?: boolean }) => {
      if ((opts.entity && !opts.id) || (!opts.entity && opts.id)) throw new Error('--entity and --id must be used together');
      const db = getDb();
      const filters: OperationalLogFilters = {
        severity: opts.severity,
        component: opts.component,
        action: opts.action,
        entityType: opts.entity,
        entityId: opts.id,
        jobId: opts.job,
        limit: opts.limit,
      };
      // listOperationalLogs orders DESC and caps at `limit` (default 100) —
      // fine for the initial snapshot, but once a cursor (afterId) is
      // active it must not apply that same cap: DESC+LIMIT+reverse would
      // return only the *newest* unseen rows and silently drop older ones
      // once more than `limit` rows land between two polls. A generous
      // fixed cap here comfortably covers any realistic burst between
      // 500ms polls without reworking listOperationalLogs' sort order.
      const FOLLOW_BATCH_LIMIT = 10_000;
      let lastId = 0;
      const print = (): void => {
        const pageFilters = lastId ? { ...filters, afterId: lastId, limit: FOLLOW_BATCH_LIMIT } : filters;
        const logs = listOperationalLogs(db, pageFilters).reverse();
        for (const log of logs) {
          printLog(log);
          lastId = Math.max(lastId, log.id);
        }
      };
      print();
      if (!opts.follow) return;
      await new Promise<void>((resolve) => {
        const timer = setInterval(print, 500);
        process.once('SIGINT', () => { clearInterval(timer); resolve(); });
      });
    });
}
