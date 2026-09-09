import type Database from 'better-sqlite3';
import { inferJobEntity } from '../../domain/job-entity.js';
import type { JobTopic } from '../../domain/job-topic.js';
import { NotFoundError } from '../errors.js';
import { sanitizeOperationalError, tryRecordOperationalLog } from './operational-logs.js';

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
  const entity = entityOf(job);
  tryRecordOperationalLog(db, {
    outcome: 'started',
    component: 'job-queue',
    action: 'enqueue',
    jobId: job.id,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
    context: { topic: job.topic, priority: job.priority },
  });
  return job;
}

/** Best-effort entity inference from a job's own payload, for log correlation — never throws on malformed payload. */
function entityOf(job: JobRecord): ReturnType<typeof inferJobEntity> {
  try {
    return inferJobEntity(JSON.parse(job.payload));
  } catch {
    return undefined;
  }
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
  const job = claimedId === undefined ? undefined : getJobById(db, claimedId);
  if (job) {
    const entity = entityOf(job);
    tryRecordOperationalLog(db, {
      outcome: 'started',
      component: 'job-queue',
      action: 'claim',
      jobId: job.id,
      entityType: entity?.entityType,
      entityId: entity?.entityId,
      context: { topic: job.topic, attempt: job.attempts + 1 },
    });
  }
  return job;
}

export function completeJob(db: Database.Database, id: number): void {
  const job = getJobById(db, id);
  db.prepare(
    "UPDATE jobs SET status = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(id);
  const entity = job ? entityOf(job) : undefined;
  tryRecordOperationalLog(db, {
    outcome: 'succeeded',
    component: 'job-queue',
    action: 'complete',
    jobId: id,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
  });
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
  const sanitizedError = sanitizeOperationalError(errorMessage);

  if (attempts >= maxAttempts) {
    db.prepare(
      "UPDATE jobs SET status = 'failed', attempts = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(attempts, sanitizedError, id);
  } else {
    const delayMs = backoffMs * 2 ** (attempts - 1);
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    db.prepare(
      "UPDATE jobs SET status = 'pending', attempts = ?, error = ?, available_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(attempts, sanitizedError, availableAt, id);
  }

  const updated = getJobById(db, id);
  if (!updated) throw new Error('Job vanished immediately after update');
  const entity = entityOf(updated);
  tryRecordOperationalLog(db, {
    severity: updated.status === 'failed' ? 'error' : 'warn',
    outcome: updated.status === 'failed' ? 'failed' : 'retried',
    component: 'job-queue',
    action: updated.status === 'failed' ? 'terminal-failure' : 'retry-scheduled',
    jobId: id,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
    context: { topic: updated.topic, attempts: updated.attempts },
    error: errorMessage,
  });
  return updated;
}

export interface JobFilters {
  status?: JobStatus;
  limit?: number;
}

export function listJobs(db: Database.Database, filters: JobFilters = {}): JobRecord[] {
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 1000));
  return db
    .prepare(`SELECT * FROM jobs ${filters.status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(filters.status ? [filters.status, limit] : [limit])) as JobRecord[];
}

export function retryFailedJob(db: Database.Database, id: number): JobRecord {
  const job = getJobById(db, id);
  if (!job) throw new NotFoundError(`Job #${id} not found`);
  if (job.status !== 'failed') throw new Error(`Job #${id} is ${job.status}, not failed`);
  db.prepare(
    "UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(id);
  const retried = getJobById(db, id);
  if (!retried) throw new Error('Job vanished immediately after retry');
  const entity = entityOf(retried);
  tryRecordOperationalLog(db, {
    outcome: 'retried',
    component: 'job-queue',
    action: 'manual-retry',
    jobId: id,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
    context: { topic: job.topic },
  });
  return retried;
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
