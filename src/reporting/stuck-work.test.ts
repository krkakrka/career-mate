import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/client.js';
import { enqueueJob } from '../db/repositories/jobs.js';
import { findStuckWork } from './stuck-work.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-stuck-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function job(status: string, fields: Record<string, string | number | null> = {}): number {
  const created = enqueueJob(db, { topic: 'enrichment', payload: { kind: 'role-structural' } });
  const sets = Object.keys(fields).map((key) => `${key} = :${key}`);
  db.prepare(`UPDATE jobs SET status = :status${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = :id`).run({
    status,
    id: created.id,
    ...fields,
  });
  return created.id;
}

describe('findStuckWork', () => {
  it('reports nothing when the queue is healthy', () => {
    job('pending');
    job('done');
    job('running', { claimed_at: minutesAgo(1), updated_at: minutesAgo(1) });

    expect(findStuckWork(db, 30)).toMatchObject({ failed: [], stranded: [], moreFailed: 0, moreStranded: 0 });
  });

  it('separates exhausted retries from a stranded claim', () => {
    // The remedies differ: a failed job needs `cm worker retry`, while a
    // stranded one is swept back into the queue by the next daemon start.
    const failed = job('failed', { error: 'boom', attempts: 3 });
    const stranded = job('running', { claimed_at: minutesAgo(90), updated_at: minutesAgo(90) });

    const stuck = findStuckWork(db, 30);
    expect(stuck.failed.map((j) => j.id)).toEqual([failed]);
    expect(stuck.stranded.map((j) => j.id)).toEqual([stranded]);
    expect(stuck.failed[0]!.error).toBe('boom');
    expect(stuck.failed[0]!.attempts).toBe(3);
  });

  it('leaves a job claimed inside the window alone', () => {
    job('running', { claimed_at: minutesAgo(29), updated_at: minutesAgo(29) });
    expect(findStuckWork(db, 30).stranded).toEqual([]);
  });

  it('uses exactly the predicate the stale sweep uses', () => {
    // Two definitions of "stranded" would drift, and the visible symptom is
    // this block promising a requeue for a job the daemon does not consider
    // stale yet. A recently-touched row with no claim time is the case that
    // separates the two predicates.
    job('running', { claimed_at: null, updated_at: minutesAgo(1) });
    expect(findStuckWork(db, 30).stranded).toEqual([]);

    job('running', { claimed_at: null, updated_at: minutesAgo(90) });
    expect(findStuckWork(db, 30).stranded.length).toBe(1);
  });

  it('never invents a claim time it does not have', () => {
    // Rows predating migration 0008 have none, and `cm status` renders this
    // as "claimed <x>" — asserting a fact the row does not carry.
    job('running', { claimed_at: null, updated_at: minutesAgo(90) });
    expect(findStuckWork(db, 30).stranded[0]!.claimedAt).toBeNull();
  });

  it('carries the attempt count for stranded jobs, not only failed ones', () => {
    // The sweep gives up at the retry limit, so a job already swept twice
    // goes terminal on the next daemon start instead of being requeued.
    // Without this on screen, the printed remedy is unpredictable.
    job('running', { claimed_at: minutesAgo(90), updated_at: minutesAgo(90), attempts: 2 });
    expect(findStuckWork(db, 30).stranded[0]!.attempts).toBe(2);
  });

  it('stops reporting a failure once it is old enough to be history', () => {
    // The only exit from `failed` is a per-id retry. Unbounded, one bad
    // night becomes a permanent block on every `cm status` — the thing you
    // learn to skip, which defeats the point.
    job('failed', { error: 'ancient', updated_at: minutesAgo(30 * 24 * 60) });
    job('failed', { error: 'recent', updated_at: minutesAgo(5) });

    const stuck = findStuckWork(db, 30);
    expect(stuck.failed.map((j) => j.error)).toEqual(['recent']);
    expect(stuck.moreFailed).toBe(0);
  });

  it('orders deterministically when timestamps tie', () => {
    // A crash sweep fails several jobs in a loop of separate UPDATEs, so
    // ties on a millisecond timestamp are ordinary; without a tiebreaker
    // SQLite may return a different five on consecutive runs.
    const same = minutesAgo(5);
    const ids = [job('failed', { updated_at: same }), job('failed', { updated_at: same }), job('failed', { updated_at: same })];

    const first = findStuckWork(db, 30).failed.map((j) => j.id);
    expect(first).toEqual([...ids].sort((a, b) => b - a));
    expect(findStuckWork(db, 30).failed.map((j) => j.id)).toEqual(first);
  });

  it('caps each list and counts the remainder rather than printing everything', () => {
    for (let n = 0; n < 8; n += 1) job('failed', { error: `boom ${n}` });
    for (let n = 0; n < 7; n += 1) job('running', { claimed_at: minutesAgo(60 + n), updated_at: minutesAgo(60 + n) });

    const stuck = findStuckWork(db, 30);
    expect(stuck.failed.length).toBe(5);
    expect(stuck.moreFailed).toBe(3);
    expect(stuck.stranded.length).toBe(5);
    expect(stuck.moreStranded).toBe(2);
  });

  it('lists the jobs most worth acting on first', () => {
    // Most recent failure first — that is the one you were probably just
    // waiting on. Oldest claim first among stranded — that one has been
    // stuck longest.
    const older = job('failed', { updated_at: minutesAgo(600) });
    const newer = job('failed', { updated_at: minutesAgo(5) });
    const longest = job('running', { claimed_at: minutesAgo(600), updated_at: minutesAgo(600) });
    const shorter = job('running', { claimed_at: minutesAgo(60), updated_at: minutesAgo(60) });

    const stuck = findStuckWork(db, 30);
    expect(stuck.failed.map((j) => j.id)).toEqual([newer, older]);
    expect(stuck.stranded.map((j) => j.id)).toEqual([longest, shorter]);
  });
});
