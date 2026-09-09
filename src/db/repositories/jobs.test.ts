import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.js';
import { InvalidStateError, NotFoundError } from '../errors.js';
import {
  claimNextJob,
  completeJob,
  countJobsByStatus,
  enqueueJob,
  failJob,
  getJobById,
  listJobs,
  retryFailedJob,
} from './jobs.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-jobs-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('enqueueJob / claimNextJob', () => {
  it('claims a pending job, marking it running', () => {
    const job = enqueueJob(db, { topic: 'notification', payload: { hello: 'world' } });
    expect(job.status).toBe('pending');

    const claimed = claimNextJob(db, 'notification');
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');
    expect(JSON.parse(claimed!.payload)).toEqual({ hello: 'world' });
  });

  it('returns undefined when there is nothing claimable for the topic', () => {
    enqueueJob(db, { topic: 'enrichment' });
    expect(claimNextJob(db, 'notification')).toBeUndefined();
  });

  it('does not reclaim an already-running job', () => {
    enqueueJob(db, { topic: 'notification' });
    const first = claimNextJob(db, 'notification');
    expect(first).toBeDefined();
    expect(claimNextJob(db, 'notification')).toBeUndefined();
  });

  it('claims higher-priority jobs first', () => {
    const low = enqueueJob(db, { topic: 'notification', priority: 0 });
    const high = enqueueJob(db, { topic: 'notification', priority: 10 });

    expect(claimNextJob(db, 'notification')?.id).toBe(high.id);
    expect(claimNextJob(db, 'notification')?.id).toBe(low.id);
  });
});

describe('completeJob', () => {
  it('marks a job done', () => {
    const job = enqueueJob(db, { topic: 'notification' });
    claimNextJob(db, 'notification');
    completeJob(db, job.id);
    expect(getJobById(db, job.id)?.status).toBe('done');
  });
});

describe('failJob', () => {
  it('retries with a future available_at when under maxAttempts', () => {
    const job = enqueueJob(db, { topic: 'notification' });
    claimNextJob(db, 'notification');

    const failed = failJob(db, job.id, 'boom', { maxAttempts: 3, backoffMs: 1000 });
    expect(failed.status).toBe('pending');
    expect(failed.attempts).toBe(1);
    expect(failed.error).toBe('boom');
    expect(new Date(failed.available_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('is not reclaimable until its backoff elapses, then is', () => {
    const job = enqueueJob(db, { topic: 'notification' });
    claimNextJob(db, 'notification');
    failJob(db, job.id, 'boom', { maxAttempts: 5, backoffMs: 50 });

    expect(claimNextJob(db, 'notification')).toBeUndefined();

    // Manually move available_at into the past to simulate the backoff having elapsed,
    // rather than sleeping — this is pure state-machine logic, not timing behavior.
    db.prepare("UPDATE jobs SET available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ?").run(
      job.id,
    );
    expect(claimNextJob(db, 'notification')?.id).toBe(job.id);
  });

  it('lands in failed once attempts reaches maxAttempts', () => {
    const job = enqueueJob(db, { topic: 'notification' });
    claimNextJob(db, 'notification');
    failJob(db, job.id, 'boom 1', { maxAttempts: 2, backoffMs: 1 });

    db.prepare("UPDATE jobs SET available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ?").run(
      job.id,
    );
    claimNextJob(db, 'notification');
    const final = failJob(db, job.id, 'boom 2', { maxAttempts: 2, backoffMs: 1 });

    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(2);
    expect(final.error).toBe('boom 2');
    expect(claimNextJob(db, 'notification')).toBeUndefined();
  });
});

describe('listJobs / retryFailedJob', () => {
  it('lists failed jobs and manually re-queues one with cleared attempt state', () => {
    const job = enqueueJob(db, { topic: 'notification' });
    claimNextJob(db, 'notification');
    failJob(db, job.id, 'token=private', { maxAttempts: 1 });
    expect(listJobs(db, { status: 'failed' }).map((item) => item.id)).toContain(job.id);
    const retried = retryFailedJob(db, job.id);
    expect(retried.status).toBe('pending');
    expect(retried.attempts).toBe(0);
    expect(retried.error).toBeNull();
  });

  it('rejects retrying a job that is not in failed status, with a typed (not plain) error', () => {
    const job = enqueueJob(db, { topic: 'notification' }); // stays 'pending'
    expect(() => retryFailedJob(db, job.id)).toThrow(InvalidStateError);
  });

  it('rejects retrying an unknown job id, with a typed (not plain) error', () => {
    expect(() => retryFailedJob(db, 999)).toThrow(NotFoundError);
  });
});

describe('countJobsByStatus', () => {
  it('tallies jobs across all statuses', () => {
    enqueueJob(db, { topic: 'notification' });
    const toComplete = enqueueJob(db, { topic: 'notification' });
    const toFail = enqueueJob(db, { topic: 'notification' });

    claimNextJob(db, 'notification'); // claims the first pending one
    claimNextJob(db, 'notification'); // claims toComplete (fifo by id after the first)
    completeJob(db, toComplete.id);
    claimNextJob(db, 'notification'); // claims toFail
    failJob(db, toFail.id, 'boom', { maxAttempts: 1, backoffMs: 1 });

    const counts = countJobsByStatus(db);
    expect(counts.running).toBe(1);
    expect(counts.done).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.pending).toBe(0);
  });
});
