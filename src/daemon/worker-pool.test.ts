import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/client.js';
import { enqueueJob, getJobById, listJobs } from '../db/repositories/jobs.js';
import { drainOnce, startPolling } from './worker-pool.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-worker-pool-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('drainOnce', () => {
  it('runs a successful handler and marks the job done', async () => {
    const job = enqueueJob(db, { topic: 'notification', payload: { n: 1 } });
    let received: unknown;

    await drainOnce({
      db,
      handlers: { notification: (j) => void (received = JSON.parse(j.payload)) },
      concurrency: { notification: 1 },
    });

    expect(received).toEqual({ n: 1 });
    expect(getJobById(db, job.id)?.status).toBe('done');
  });

  it('leaves topics with no registered handler alone', async () => {
    const job = enqueueJob(db, { topic: 'enrichment' });
    await drainOnce({ db, handlers: {}, concurrency: {} });
    expect(getJobById(db, job.id)?.status).toBe('pending');
  });

  it('retries a failing handler with backoff, then lands in failed at maxAttempts', async () => {
    const job = enqueueJob(db, { topic: 'notification' });
    let callCount = 0;

    const handlers = {
      notification: () => {
        callCount += 1;
        throw new Error('boom');
      },
    };

    // Each drainOnce pass claims at most once per job (a job that just
    // failed isn't reclaimable within the same synchronous pass, since
    // failJob always pushes available_at slightly into the future) — so
    // driving 3 attempts means 3 ticks, waiting out backoff between them.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await drainOnce({ db, handlers, concurrency: { notification: 1 }, maxAttempts: 3, backoffMs: 5 });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(callCount).toBe(3);
    const final = getJobById(db, job.id);
    expect(final?.status).toBe('failed');
    expect(final?.attempts).toBe(3);
    expect(final?.error).toBe('boom');
  });

  it('runs jobs on a concurrency=1 topic strictly serially', async () => {
    enqueueJob(db, { topic: 'notification' });
    enqueueJob(db, { topic: 'notification' });
    const windows: { start: number; end: number }[] = [];

    await drainOnce({
      db,
      handlers: {
        notification: async () => {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 40));
          windows.push({ start, end: Date.now() });
        },
      },
      concurrency: { notification: 1 },
    });

    expect(windows).toHaveLength(2);
    const [first, second] = windows.sort((a, b) => a.start - b.start);
    expect(second!.start).toBeGreaterThanOrEqual(first!.end);
  });

  it('runs jobs on a higher-concurrency topic in parallel', async () => {
    enqueueJob(db, { topic: 'notification' });
    enqueueJob(db, { topic: 'notification' });
    const windows: { start: number; end: number }[] = [];

    await drainOnce({
      db,
      handlers: {
        notification: async () => {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 40));
          windows.push({ start, end: Date.now() });
        },
      },
      concurrency: { notification: 2 },
    });

    expect(windows).toHaveLength(2);
    const [first, second] = windows.sort((a, b) => a.start - b.start);
    expect(second!.start).toBeLessThan(first!.end);
  });
});

describe('startPolling', () => {
  it('keeps polling after a tick fails instead of crashing or silently stalling', async () => {
    // A closed connection makes claimNextJob throw synchronously — this
    // happens outside drainSlot's try/catch, so it's exactly the failure
    // mode the poll loop's own tick() needs to survive (a plain handler
    // throw is already covered by the retry/backoff tests above).
    const brokenDbPath = path.join(tempDir, 'broken.db');
    const brokenDb = openDb(brokenDbPath);
    brokenDb.close();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handle = startPolling(
      { db: brokenDb, handlers: { notification: () => {} }, concurrency: { notification: 1 } },
      15,
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(handle.stop()).resolves.toBeUndefined();

    // More than one call proves ticks kept getting rescheduled after failing, not just the first.
    expect(errorSpy.mock.calls.length).toBeGreaterThan(1);
    errorSpy.mockRestore();
  });
});

describe('stop() actually stops', () => {
  it('abandons the rest of the queue instead of draining it', async () => {
    for (let i = 0; i < 20; i += 1) {
      enqueueJob(db, { topic: 'notification', payload: { index: i } });
    }

    let handled = 0;
    const handlers = {
      notification: async (): Promise<void> => {
        handled += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    };

    const handle = startPolling({ db, handlers, concurrency: { notification: 1 } }, 5);
    // Let a couple of jobs run, then ask it to stop from outside, the way
    // SIGTERM does.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await handle.stop();
    const handledAtStop = handled;

    // Without the stopped check inside drainSlot, stop() waited for every
    // claimable job in every topic — so a shutdown with a full queue kept
    // claiming and running jobs (each able to spend a full model budget and
    // take the full timeout) for minutes after being asked to stop.
    expect(handledAtStop).toBeLessThan(20);
    expect(listJobs(db).filter((job) => job.status === 'pending').length).toBeGreaterThan(0);

    // And it stays stopped.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handled).toBe(handledAtStop);
  });
});
