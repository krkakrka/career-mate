import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { countJobsByStatus } from '../../db/repositories/jobs.js';
import { buildHandlerRegistry, DEFAULT_TOPIC_CONCURRENCY } from '../../daemon/handlers/index.js';
import { drainOnce } from '../../daemon/worker-pool.js';

export function registerWorkerCommand(program: Command): void {
  const worker = program.command('worker').description('Inspect and control queued jobs');

  worker
    .command('drain')
    .description('Process all pending jobs now, without waiting for the daemon loop')
    .action(async () => {
      const db = getDb();
      const handlers = buildHandlerRegistry(db);
      await drainOnce({ db, handlers, concurrency: DEFAULT_TOPIC_CONCURRENCY });
      console.log('Drained all currently-claimable jobs.');
    });

  worker
    .command('status')
    .description('Show pending/running/done/failed job counts')
    .action(() => {
      const db = getDb();
      const counts = countJobsByStatus(db);
      console.log(
        `pending=${counts.pending}  running=${counts.running}  done=${counts.done}  failed=${counts.failed}`,
      );
    });
}
