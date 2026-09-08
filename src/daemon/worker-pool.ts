import type Database from 'better-sqlite3';
import { claimNextJob, completeJob, failJob, type JobRecord } from '../db/repositories/jobs.js';
import type { JobTopic } from '../domain/job-topic.js';

export type JobHandler = (job: JobRecord) => void | Promise<void>;

export interface WorkerPoolOptions {
  db: Database.Database;
  /** Topics with no registered handler are simply not drained — safe for topics no step has wired up yet. */
  handlers: Partial<Record<JobTopic, JobHandler>>;
  /** Defaults to 1 for any topic not listed (enrichment/tips are Playwright-bound and must stay serialized). */
  concurrency: Partial<Record<JobTopic, number>>;
  maxAttempts?: number;
  backoffMs?: number;
}

const DEFAULT_CONCURRENCY = 1;

async function drainSlot(options: WorkerPoolOptions, topic: JobTopic): Promise<void> {
  const handler = options.handlers[topic];
  if (!handler) return;

  for (;;) {
    const job = claimNextJob(options.db, topic);
    if (!job) return;

    try {
      await handler(job);
      completeJob(options.db, job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failJob(options.db, job.id, message, {
        maxAttempts: options.maxAttempts,
        backoffMs: options.backoffMs,
      });
    }
  }
}

/**
 * Processes every currently-claimable job across all registered-handler
 * topics, respecting per-topic concurrency, until each topic's queue is
 * empty. Does not wait for jobs that become claimable later (retry backoff,
 * future available_at) — that's the daemon's polling loop's job. This is
 * what `cm worker drain` calls directly, and what the poll loop calls once
 * per tick.
 */
export async function drainOnce(options: WorkerPoolOptions): Promise<void> {
  const topics = Object.keys(options.handlers) as JobTopic[];
  await Promise.all(
    topics.flatMap((topic) => {
      const concurrency = options.concurrency[topic] ?? DEFAULT_CONCURRENCY;
      return Array.from({ length: concurrency }, () => drainSlot(options, topic));
    }),
  );
}

export interface PollingHandle {
  stop: () => Promise<void>;
}

/** Runs drainOnce on an interval until stop() is called; used by the daemon process. */
export function startPolling(options: WorkerPoolOptions, pollIntervalMs = 1000): PollingHandle {
  let stopped = false;
  let currentRun: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const tick = (): void => {
    if (stopped) return;
    currentRun = drainOnce(options)
      .catch((error: unknown) => {
        // A tick failing (e.g. claimNextJob hitting a transient SQLITE_BUSY)
        // must not kill the poll loop — log and keep going. Without this,
        // the rejection was unhandled: Node terminates the process by
        // default, and even short of that, the `if (!stopped)` reschedule
        // below would simply never run, silently stalling the daemon.
        console.error('[daemon] drain tick failed:', error instanceof Error ? error.message : error);
      })
      .then(() => {
        if (!stopped) timer = setTimeout(tick, pollIntervalMs);
      });
  };
  tick();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await currentRun;
    },
  };
}
