import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './client.js';
import { enqueueJob } from './repositories/jobs.js';
import { recordModelCall } from './repositories/model-calls.js';
import { recordOperationalLog } from './repositories/operational-logs.js';
import { pruneOldRecords } from './prune.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-prune-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function log(when: string): void {
  recordOperationalLog(db, { outcome: 'succeeded', component: 'cli', action: 'x' });
  db.prepare('UPDATE operational_logs SET occurred_at = ? WHERE id = (SELECT MAX(id) FROM operational_logs)').run(when);
}

function job(status: string, when: string): number {
  const created = enqueueJob(db, { topic: 'enrichment', payload: { kind: 'role-structural' } });
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, when, created.id);
  return created.id;
}

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('pruneOldRecords', () => {
  it('removes old diagnostics and keeps recent ones', () => {
    log(daysAgo(120));
    log(daysAgo(1));
    job('done', daysAgo(120));
    job('done', daysAgo(1));

    // Counted as a delta: `enqueueJob` writes its own log row, so the
    // absolute total includes bookkeeping this test did not create.
    const logsBefore = count('operational_logs');
    const result = pruneOldRecords(db, 90);

    expect(result).toMatchObject({ operationalLogs: 1, doneJobs: 1 });
    expect(count('operational_logs')).toBe(logsBefore - 1);
    expect(count('jobs')).toBe(1);
  });

  it('leaves unfinished work alone however old it is', () => {
    // A failed job is business `cm status` still reports; pending and
    // running are live. Age is not the question for any of them.
    job('failed', daysAgo(400));
    job('pending', daysAgo(400));
    job('running', daysAgo(400));

    expect(pruneOldRecords(db, 90).doneJobs).toBe(0);
    expect(count('jobs')).toBe(3);
  });

  it('never touches the spend ledger', () => {
    // Money already spent cannot be un-spent by deleting its row, and the
    // 30-day total on `cm status` would quietly shrink.
    const old = job('done', daysAgo(400));
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.4, jobId: old });

    pruneOldRecords(db, 90);

    expect(count('jobs')).toBe(0);
    expect(count('model_calls')).toBe(1);
  });

  it('leaves a pruned job\'s spend fully attributed', () => {
    // The reason migration 0011 exists: the foreign key is ON DELETE SET
    // NULL, so before it, pruning a job moved its spend into
    // "unattributed" and rewrote the CLI-vs-agent answer with no trace.
    const old = job('done', daysAgo(400));
    db.prepare("UPDATE jobs SET origin = 'mcp' WHERE id = ?").run(old);
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.4, jobId: old });

    pruneOldRecords(db, 90);

    const row = db.prepare('SELECT origin, job_id FROM model_calls').get() as { origin: string | null; job_id: number | null };
    expect(row.origin).toBe('mcp');
    expect(row.job_id).toBeNull(); // the FK did its thing; the origin survived it
  });

  it('prunes nothing for a window that is not a positive number of days', () => {
    // Every wrong answer here is destructive in the same direction, so the
    // guard refuses rather than clamps. `-1` clamped to `0` produced a
    // cutoff of *now*, matching every row in the table, and `+Infinity`
    // plainly means "keep everything".
    log(daysAgo(400));
    job('done', daysAgo(400));

    for (const days of [0, -30, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(pruneOldRecords(db, days, { dryRun: true }), String(days)).toMatchObject({
        operationalLogs: 0,
        doneJobs: 0,
      });
    }
    expect(pruneOldRecords(db, Number.NaN)).toMatchObject({ operationalLogs: 0, doneJobs: 0 });
    expect(count('jobs')).toBe(1);
  });

  it('keeps the diagnostics of a job it is keeping, however old they are', () => {
    // `cm status` invites you to retry a failed job. Deleting the rows that
    // say why it failed leaves one you are told to act on and cannot debug,
    // with `cm logs --job <id>` returning nothing.
    const failed = job('failed', daysAgo(400));
    recordOperationalLog(db, { severity: 'error', outcome: 'failed', component: 'job-queue', action: 'terminal-failure', jobId: failed });
    db.prepare('UPDATE operational_logs SET occurred_at = ? WHERE job_id = ?').run(daysAgo(400), failed);

    const forJob = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM operational_logs WHERE job_id = ?').get(failed) as { n: number }).n;
    // Every row for this job, not just the one written here: `enqueueJob`
    // logs its own, and both are equally old and equally needed.
    const before = forJob();
    expect(before).toBeGreaterThan(1);

    pruneOldRecords(db, 90);

    expect(forJob()).toBe(before);
  });

  it('does prune the diagnostics of a job it is removing', () => {
    // The exemption is for surviving jobs only; a completed job's logs go
    // with it, which is the point of the command.
    const done = job('done', daysAgo(400));
    recordOperationalLog(db, { outcome: 'succeeded', component: 'job-queue', action: 'complete', jobId: done });
    db.prepare('UPDATE operational_logs SET occurred_at = ? WHERE job_id = ?').run(daysAgo(400), done);

    expect(pruneOldRecords(db, 90).operationalLogs).toBeGreaterThanOrEqual(1);
    expect(count('jobs')).toBe(0);
  });

  it('reclaims space only when asked', () => {
    // VACUUM rewrites the whole database under a write lock; bounding growth
    // is the goal, and reclaiming the file is a heavier, separate ask.
    log(daysAgo(400));
    expect(() => pruneOldRecords(db, 90, { vacuum: true })).not.toThrow();
    expect(count('jobs')).toBe(0);
  });

  it('reports what it would do without doing it', () => {
    log(daysAgo(120));
    job('done', daysAgo(120));

    const logsBefore = count('operational_logs');
    const dry = pruneOldRecords(db, 90, { dryRun: true });

    expect(dry).toMatchObject({ operationalLogs: 1, doneJobs: 1 });
    expect(count('operational_logs')).toBe(logsBefore);
    expect(count('jobs')).toBe(1);
  });

  it('judges a job by when it last ran, not when it was created', () => {
    // A job created months ago but retried this morning is recent work, and
    // its diagnostics are what you would be reading right now.
    const created = enqueueJob(db, { topic: 'enrichment', payload: {} });
    db.prepare("UPDATE jobs SET status = 'done', created_at = ?, updated_at = ? WHERE id = ?").run(
      daysAgo(400),
      daysAgo(1),
      created.id,
    );

    expect(pruneOldRecords(db, 90).doneJobs).toBe(0);
  });

});
