import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { countJobsByStatus, listJobs, retryFailedJob, type JobStatus } from '../../db/repositories/jobs.js';
import { sanitizeOperationalValue } from '../../db/repositories/operational-logs.js';
import { InvalidStateError, NotFoundError } from '../../db/errors.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { parsePositiveInt } from '../parsers.js';
import { buildHandlerRegistry, DEFAULT_TOPIC_CONCURRENCY } from '../../daemon/handlers/index.js';
import { drainOnce } from '../../daemon/worker-pool.js';

function printJob(job: ReturnType<typeof listJobs>[number]): void {
  const payload = JSON.stringify(sanitizeOperationalValue(JSON.parse(job.payload)));
  console.log(`#${job.id}  ${job.topic}  ${job.status}  attempts=${job.attempts}  ${job.updated_at}`);
  console.log(`  payload: ${payload}`);
  if (job.error) console.log(`  error: ${JSON.stringify(sanitizeOperationalValue(job.error))}`);
}

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

  worker
    .command('jobs')
    .description('List jobs and their saved diagnostics')
    .option('--status <status>', 'Filter by status (pending|running|done|failed)')
    .action((opts: { status?: JobStatus }) => {
      const jobs = listJobs(getDb(), { status: opts.status });
      if (jobs.length === 0) console.log('No jobs match.');
      for (const job of jobs) printJob(job);
    });

  worker
    .command('failed')
    .description('List terminally failed jobs')
    .action(() => {
      const jobs = listJobs(getDb(), { status: 'failed' });
      if (jobs.length === 0) console.log('No failed jobs.');
      for (const job of jobs) printJob(job);
    });

  worker
    .command('retry')
    .description('Retry a terminally failed job')
    .argument('<id>', 'Job id', parsePositiveInt)
    .action((id: number) => {
      reportKnownErrors([NotFoundError, InvalidStateError], () => {
        const job = retryFailedJob(getDb(), id);
        console.log(`Job #${job.id} re-queued.`);
      });
    });
}
