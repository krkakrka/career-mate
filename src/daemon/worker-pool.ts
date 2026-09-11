import type Database from 'better-sqlite3';
import { claimNextJob, completeJob, failJob, type JobRecord } from '../db/repositories/jobs.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
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
  /**
   * Consulted between jobs. Without it, `stop()` did not stop anything —
   * it waited for every claimable job in every topic to finish, so a
   * shutdown with ten enrichment jobs queued kept claiming and running
   * them (each able to spend a full budget and take the full timeout) for
   * many minutes after the daemon was asked to stop.
   */
  isStopped?: () => boolean;
}

const DEFAULT_CONCURRENCY = 1;

async function drainSlot(options: WorkerPoolOptions, topic: JobTopic): Promise<number> {
  const handler = options.handlers[topic];
  if (!handler) return 0;

  let processed = 0;
  for (;;) {
    if (options.isStopped?.()) return processed;

    const job = claimNextJob(options.db, topic);
    if (!job) return processed;
    processed += 1;

    // No start/fail logging here — claimNextJob/completeJob/failJob in
    // jobs.ts already record the full lifecycle (including entity
    // correlation), so a second log here would just duplicate every entry.
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
export async function drainOnce(options: WorkerPoolOptions): Promise<number> {
  const topics = Object.keys(options.handlers) as JobTopic[];
  const processed = await Promise.all(
    topics.flatMap((topic) => {
      const concurrency = options.concurrency[topic] ?? DEFAULT_CONCURRENCY;
      return Array.from({ length: concurrency }, () => drainSlot(options, topic));
    }),
  );
  return processed.reduce((total, count) => total + count, 0);
}

export interface PollingHandle {
  stop: () => Promise<void>;
}

export interface PollingOptions {
  /**
   * Consulted after every tick. Returning a reason stops the loop and
   * reports it — the daemon uses this for its own lifecycle policy (its
   * data directory has been deleted, or it has been idle long enough to be
   * worth exiting) without the pool needing to know about any of that.
   */
  shouldStop?: (workDone: number) => string | undefined;
  onStopped?: (reason: string) => void;
}

/** Runs drainOnce on an interval until stop() is called; used by the daemon process. */
export function startPolling(
  options: WorkerPoolOptions,
  pollIntervalMs = 1000,
  lifecycle: PollingOptions = {},
): PollingHandle {
  let stopped = false;
  let currentRun: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const tick = (): void => {
    if (stopped) return;
    currentRun = drainOnce({ ...options, isStopped: () => stopped })
      .then((workDone) => {
        const reason = lifecycle.shouldStop?.(workDone);
        if (reason !== undefined) {
          stopped = true;
          lifecycle.onStopped?.(reason);
        }
      })
      .catch((error: unknown) => {
        // A tick failing (e.g. claimNextJob hitting a transient SQLITE_BUSY)
        // must not kill the poll loop — log and keep going. Without this,
        // the rejection was unhandled: Node terminates the process by
        // default, and even short of that, the `if (!stopped)` reschedule
        // below would simply never run, silently stalling the daemon.
        const message = error instanceof Error ? error.message : String(error);
        tryRecordOperationalLog(options.db, {
          severity: 'error', outcome: 'failed', component: 'daemon', action: 'poll', error,
        });
        console.error('[daemon] drain tick failed:', message);
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
