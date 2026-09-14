/**
 * Work the pipeline has quietly stopped making progress on.
 *
 * Read-only commands deliberately never start a daemon — that is what keeps
 * `cm roles list` from spawning a background process per row — so a session
 * spent only reading never learns that a job died three days ago and the
 * enrichment it was supposed to produce is never coming. Nothing else
 * reports it either: `cm worker failed` exists but you have to already
 * suspect something is wrong to run it.
 *
 * Two distinct conditions, kept separate because the remedies differ:
 *
 * - **failed** — retries exhausted. It will never run again on its own;
 *   `cm worker retry <id>` is the only way out.
 * - **stranded** — `running` past `stale_running_job_minutes`, meaning the
 *   process that claimed it is gone (kill -9, a crash, a closed laptop).
 *   The next daemon start sweeps these back into the queue, so the remedy
 *   is usually just "start the daemon" — which is exactly what a read-only
 *   session is not doing. *Usually*, not always: the sweep increments
 *   `attempts` and gives up at `DEFAULT_MAX_ATTEMPTS`, so a job that has
 *   already been swept twice goes terminal on the next one instead. That is
 *   why `attempts` is reported for stranded jobs too.
 *
 * The stranded predicate deliberately matches `requeueStaleRunningJobs`
 * exactly — `updated_at`, not `claimed_at`. Two definitions of "stranded"
 * would drift, and the visible symptom would be this block promising a
 * requeue for a job the daemon does not consider stale yet.
 */

import type Database from 'better-sqlite3';
import type { JobRecord } from '../db/repositories/jobs.js';

export interface StuckJob {
  id: number;
  topic: string;
  payload: string;
  attempts: number;
  error: string | null;
  /** When it last did anything — `updated_at`, the same column the stale sweep judges it by. */
  since: string;
  /** Null when the claim time was never recorded (rows predating migration 0008); never guessed from another column. */
  claimedAt: string | null;
}

export interface StuckWork {
  failed: StuckJob[];
  stranded: StuckJob[];
  /** Everything beyond what is listed, so a long tail is visible without printing it. */
  moreFailed: number;
  moreStranded: number;
}

const LISTED = 5;

/**
 * How far back a failed job is still worth reporting.
 *
 * Every other block in the digest is windowed, and this one has no natural
 * exit: the only way a row leaves `failed` is a per-id `cm worker retry`.
 * Unbounded, an expired credential that failed forty jobs overnight would
 * print five of them plus "and 35 more" on every `cm status` forever — the
 * permanent block you learn to skip, which is exactly what this is for.
 */
const FAILED_WINDOW_DAYS = 14;

function toStuckJob(row: JobRecord): StuckJob {
  return {
    id: row.id,
    topic: row.topic,
    payload: row.payload,
    attempts: row.attempts,
    error: row.error,
    since: row.updated_at,
    claimedAt: row.claimed_at,
  };
}

export function findStuckWork(db: Database.Database, staleRunningMinutes: number): StuckWork {
  // Counted with its own query rather than inferred from `LIMIT n + 1`,
  // which can only ever say "at least one more" — and "3 more failed jobs"
  // is the difference between a blip and a pipeline that has stopped.
  // `, id DESC` is a tiebreaker, not decoration: a crash sweep fails several
  // jobs in a loop of separate UPDATEs, so ties on a millisecond timestamp
  // are ordinary, and without it SQLite may return a different five on
  // consecutive runs with nothing in the database changed.
  const failedSince = new Date(Date.now() - FAILED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const FAILED_WHERE = "status = 'failed' AND updated_at >= ?";
  const failedRows = db
    .prepare(`SELECT * FROM jobs WHERE ${FAILED_WHERE} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(failedSince, LISTED) as JobRecord[];
  const failedTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${FAILED_WHERE}`).get(failedSince) as { n: number }
  ).n;

  // Byte-for-byte the sweeper's own predicate. Keying on `claimed_at`
  // instead looked more precise and was wrong: a `running` row with no
  // claim time but a recent `updated_at` would be reported as stranded
  // while the daemon would not touch it, so the block would promise a
  // requeue that never came. `updated_at` also covers the pre-0008 rows
  // that motivated the NULL check, because those are old by definition.
  const cutoff = new Date(Date.now() - Math.max(0, staleRunningMinutes) * 60 * 1000).toISOString();
  const STRANDED_WHERE = "status = 'running' AND updated_at <= ?";
  const strandedRows = db
    .prepare(`SELECT * FROM jobs WHERE ${STRANDED_WHERE} ORDER BY updated_at ASC, id ASC LIMIT ?`)
    .all(cutoff, LISTED) as JobRecord[];
  const strandedTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${STRANDED_WHERE}`).get(cutoff) as { n: number }
  ).n;

  return {
    failed: failedRows.map(toStuckJob),
    stranded: strandedRows.map(toStuckJob),
    moreFailed: Math.max(0, failedTotal - failedRows.length),
    moreStranded: Math.max(0, strandedTotal - strandedRows.length),
  };
}
