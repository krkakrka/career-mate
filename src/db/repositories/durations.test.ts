import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.js';
import { claimNextJob, completeJob, enqueueJob, failJob, getJobById } from './jobs.js';
import { listOperationalLogs } from './operational-logs.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-durations-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Backdates the claim so a measurable amount of time appears to have passed, returning the new claim time. */
function claimedAgo(jobId: number, ms: number): string {
  const claimedAt = new Date(Date.now() - ms).toISOString();
  db.prepare('UPDATE jobs SET claimed_at = ? WHERE id = ?').run(claimedAt, jobId);
  return claimedAt;
}

describe('job duration', () => {
  it('records how long a completed job took, measured from the claim', () => {
    const job = enqueueJob(db, { topic: 'notification', payload: {} });
    claimNextJob(db, 'notification');
    claimedAgo(job.id, 1500);

    completeJob(db, job.id);

    // From the claim, not from creation: how long the work took is a
    // different question from how long it queued, and the enqueue/claim
    // records already answer the latter.
    const duration = getJobById(db, job.id)!.duration_ms!;
    expect(duration).toBeGreaterThanOrEqual(1500);
    expect(duration).toBeLessThan(10_000);
  });

  it('records the duration of a terminal failure, not just a success', () => {
    const job = enqueueJob(db, { topic: 'notification', payload: {} });
    claimNextJob(db, 'notification');
    claimedAgo(job.id, 2000);

    // A slow failure is the most interesting kind: a timeout is
    // indistinguishable from a fast crash without this.
    failJob(db, job.id, 'boom', { maxAttempts: 1 });

    expect(getJobById(db, job.id)!.status).toBe('failed');
    expect(getJobById(db, job.id)!.duration_ms).toBeGreaterThanOrEqual(2000);
  });

  it('leaves duration null while a job is still pending or running', () => {
    const job = enqueueJob(db, { topic: 'notification', payload: {} });
    expect(getJobById(db, job.id)!.duration_ms).toBeNull();

    claimNextJob(db, 'notification');
    expect(getJobById(db, job.id)!.duration_ms).toBeNull();
  });

  it('carries the duration onto the operational log, so cm logs can show it', () => {
    const job = enqueueJob(db, { topic: 'notification', payload: {} });
    claimNextJob(db, 'notification');
    claimedAgo(job.id, 1200);
    completeJob(db, job.id);

    const completion = listOperationalLogs(db, { action: 'complete' })[0]!;
    expect(completion.duration_ms).toBeGreaterThanOrEqual(1200);

    // The `started`/`claim` records have nothing to report yet.
    expect(listOperationalLogs(db, { action: 'claim' })[0]!.duration_ms).toBeNull();
  });
});

describe('duration under a concurrent re-claim', () => {
  it('reports this worker\'s own elapsed time, not the re-claimer\'s', () => {
    const job = enqueueJob(db, { topic: 'notification', payload: {} });
    claimNextJob(db, 'notification');
    const myClaim = claimedAgo(job.id, 35 * 60 * 1000);

    // The stale sweep requeues it and another worker re-claims, re-stamping
    // claimed_at — all while this worker is still running.
    db.prepare("UPDATE jobs SET status = 'running', claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(job.id);

    completeJob(db, job.id, myClaim);

    // Reading the row here would report ~0ms for 35 minutes of work.
    expect(getJobById(db, job.id)!.duration_ms).toBeGreaterThanOrEqual(35 * 60 * 1000);
  });

  it('records the duration of a retried attempt on the row, not only in the log', () => {
    const job = enqueueJob(db, { topic: 'notification', payload: {} });
    claimNextJob(db, 'notification');
    const myClaim = claimedAgo(job.id, 3000);

    failJob(db, job.id, 'transient', { maxAttempts: 3, claimedAt: myClaim });

    // Otherwise a job later killed by the stale sweep lands in `failed`
    // with no duration at all.
    expect(getJobById(db, job.id)!.status).toBe('pending');
    expect(getJobById(db, job.id)!.duration_ms).toBeGreaterThanOrEqual(3000);
  });
});
