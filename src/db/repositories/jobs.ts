import type Database from 'better-sqlite3';
import type { JobTopic } from '../../domain/job-topic.js';
import { NotFoundError } from '../errors.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobRecord {
  id: number;
  topic: JobTopic;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  available_at: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueJobParams {
  topic: JobTopic;
  payload?: unknown;
  priority?: number;
}

export function enqueueJob(db: Database.Database, params: EnqueueJobParams): JobRecord {
  const payloadJson = JSON.stringify(params.payload ?? {});
  const result = db
    .prepare('INSERT INTO jobs (topic, payload, priority) VALUES (?, ?, ?)')
    .run(params.topic, payloadJson, params.priority ?? 0);

  const job = getJobById(db, result.lastInsertRowid as number);
  if (!job) throw new Error('Job vanished immediately after insert');
  return job;
}

export function getJobById(db: Database.Database, id: number): JobRecord | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRecord | undefined;
}

/**
 * Atomically claims the oldest available pending job for a topic (highest
 * priority first), marking it `running`. The select-then-update happens in
 * one BEGIN IMMEDIATE transaction so two workers (in this process or a
 * concurrent one) never claim the same job.
 */
export function claimNextJob(db: Database.Database, topic: JobTopic): JobRecord | undefined {
  const claim = db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT id FROM jobs
         WHERE topic = ? AND status = 'pending' AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY priority DESC, available_at ASC, id ASC
         LIMIT 1`,
      )
      .get(topic) as { id: number } | undefined;
    if (!candidate) return undefined;

    db.prepare(
      "UPDATE jobs SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(candidate.id);
    return candidate.id;
  });

  const claimedId = claim.immediate();
  return claimedId === undefined ? undefined : getJobById(db, claimedId);
}

export function completeJob(db: Database.Database, id: number): void {
  db.prepare(
    "UPDATE jobs SET status = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(id);
}

export interface FailJobOptions {
  maxAttempts?: number;
  backoffMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;

/** Records a failed attempt: retries with exponential backoff until maxAttempts, then lands in `failed`. */
export function failJob(
  db: Database.Database,
  id: number,
  errorMessage: string,
  options: FailJobOptions = {},
): JobRecord {
  const job = getJobById(db, id);
  if (!job) throw new NotFoundError(`Job #${id} not found`);

  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const attempts = job.attempts + 1;

  if (attempts >= maxAttempts) {
    db.prepare(
      "UPDATE jobs SET status = 'failed', attempts = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(attempts, errorMessage, id);
  } else {
    const delayMs = backoffMs * 2 ** (attempts - 1);
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    db.prepare(
      "UPDATE jobs SET status = 'pending', attempts = ?, error = ?, available_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(attempts, errorMessage, availableAt, id);
  }

  const updated = getJobById(db, id);
  if (!updated) throw new Error('Job vanished immediately after update');
  return updated;
}

export function countJobsByStatus(db: Database.Database): Record<JobStatus, number> {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM jobs GROUP BY status').all() as {
    status: JobStatus;
    count: number;
  }[];

  const counts: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}
