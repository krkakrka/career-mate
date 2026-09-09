import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { enqueueJob, failJob } from '../../src/db/repositories/jobs.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-worker-cli-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Seeds a terminally-failed job directly (no live daemon needed) — one failJob call past maxAttempts=1 lands it in `failed`. */
function seedFailedJob(): number {
  const db = openDb(dbPath);
  const job = enqueueJob(db, { topic: 'notification', payload: { entityType: 'role', entityId: 42 } });
  failJob(db, job.id, 'token=super-secret upstream failure', { maxAttempts: 1 });
  db.close();
  return job.id;
}

describe('cm worker jobs / failed / retry', () => {
  it('lists jobs and their diagnostics, with secrets redacted', () => {
    seedFailedJob();
    const result = runCli(['worker', 'jobs'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('notification');
    expect(result.stdout).toContain('failed');
    expect(result.stdout).not.toContain('super-secret');
  });

  it('cm worker failed lists only terminally-failed jobs', () => {
    const db = openDb(dbPath);
    enqueueJob(db, { topic: 'notification' }); // stays pending
    db.close();
    const jobId = seedFailedJob();

    const result = runCli(['worker', 'failed'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`#${jobId}`);
    expect(result.stdout).not.toContain('#1  notification  pending');
  });

  it('cm worker retry re-queues a failed job', () => {
    const jobId = seedFailedJob();

    const retry = runCli(['worker', 'retry', String(jobId)], { dataDir });
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout).toContain(`Job #${jobId} re-queued`);

    const status = runCli(['worker', 'status'], { dataDir });
    expect(status.stdout).toContain('pending=1');
    expect(status.stdout).toContain('failed=0');
  });

  it('rejects retrying an unknown job id, cleanly', () => {
    const result = runCli(['worker', 'retry', '999'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/job #999 not found/i);
    expect(result.stderr).not.toMatch(/\bat\s+\S+\s+\(/);
  });
});
