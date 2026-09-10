import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import { claimNextJob } from '../../db/repositories/jobs.js';
import { createRole, getRoleById } from '../../db/repositories/roles.js';
import { startFixtureServer, type FixtureServer } from '../../../test/helpers/fixture-server.js';
import { snapshotPage } from '../../pages/store.js';
import { handleRoleClosureCheck } from './refresh.js';
import { restoreEnv } from '../../../test/helpers/env.js';

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;
let server: FixtureServer | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-refresh-handler-'));
  // These handlers snapshot pages through the page store, which resolves
  // its files via getDataDir(). Without this, any fixture route that
  // actually served a 200 would write into the project's real ./.data.
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(async () => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  await server?.close();
  server = undefined;
});

describe('handleRoleClosureCheck — always re-fetches', () => {
  it('ignores the snapshot refresh window, so a posting pulled today is detected today', async () => {
    let gone = false;
    server = await startFixtureServer({
      '/job': () => (gone ? { status: 404 } : '<html><body><p>Still hiring.</p></body></html>'),
    });
    const url = `${server.url}/job`;
    const role = createRole(db, { url });
    // A snapshot seconds old — well inside page_refresh_days.role.
    await snapshotPage(db, url, { kind: 'role' });

    gone = true;
    await handleRoleClosureCheck(db, role.id);

    // Honouring the window here would read the cached "Still hiring." text,
    // never see the 404, and still pay for the model call that follows.
    expect(server.requests).toEqual(['/job', '/job']);
    expect(getRoleById(db, role.id)!.closed_at).not.toBeNull();
  });
});

describe('handleRoleClosureCheck — HTTP 404 short-circuit', () => {
  it('marks the role closed on a real 404, with no claude call needed', async () => {
    server = await startFixtureServer({});
    const role = createRole(db, { url: `${server.url}/gone` });

    const start = Date.now();
    await handleRoleClosureCheck(db, role.id);
    const elapsedMs = Date.now() - start;

    // A real claude -p call takes seconds; this must stay fast — confirms
    // no content-extraction script ran for a plain 404.
    expect(elapsedMs).toBeLessThan(1000);

    const updated = getRoleById(db, role.id)!;
    expect(updated.closed_at).not.toBeNull();
    expect(updated.last_checked_at).not.toBeNull();

    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.some((e) => e.type === 'role.closed_detected')).toBe(true);
  });

  it('is idempotent: re-checking an already-closed role is a no-op (does not re-fetch or re-notify)', async () => {
    server = await startFixtureServer({});
    const role = createRole(db, { url: `${server.url}/gone` });
    await handleRoleClosureCheck(db, role.id);
    const firstClosedAt = getRoleById(db, role.id)!.closed_at;

    await handleRoleClosureCheck(db, role.id);

    const updated = getRoleById(db, role.id)!;
    expect(updated.closed_at).toBe(firstClosedAt);
  });

  it('throws (does not swallow) on a genuine network-level failure, so the job queue can retry it', async () => {
    const role = createRole(db, { url: 'http://127.0.0.1:1/unreachable' });
    await expect(handleRoleClosureCheck(db, role.id)).rejects.toThrow();

    // last_checked_at must NOT be stamped on a failed attempt — otherwise a
    // transient outage would look like "we checked and it's fine".
    const updated = getRoleById(db, role.id)!;
    expect(updated.last_checked_at).toBeNull();
  });

  it('marks the role closed on HTTP 410 Gone too, with no claude call needed', async () => {
    server = await startFixtureServer({ '/retired': { status: 410 } });
    const role = createRole(db, { url: `${server.url}/retired` });

    const start = Date.now();
    await handleRoleClosureCheck(db, role.id);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(getRoleById(db, role.id)!.closed_at).not.toBeNull();
  });

  it('does not double-fire the closure event/notification when two closure checks race for the same role', async () => {
    server = await startFixtureServer({}); // any unmapped path 404s
    const role = createRole(db, { url: `${server.url}/gone` });

    // Promise.all invokes both function bodies synchronously up to their
    // first await (the fetch), so both read closed_at as NULL before
    // either's write lands — reliably reproducing the TOCTOU race two
    // overlapping refresh checks (or `cm worker drain` alongside the live
    // daemon) can hit on the same role.
    await Promise.all([handleRoleClosureCheck(db, role.id), handleRoleClosureCheck(db, role.id)]);

    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.filter((e) => e.type === 'role.closed_detected')).toHaveLength(1);

    expect(claimNextJob(db, 'notification')).toBeDefined();
    expect(claimNextJob(db, 'notification')).toBeUndefined(); // exactly one notification job, not two
  });
});

describe('handleRoleClosureCheck — already-known-closed role', () => {
  it('does nothing at all for a role already marked closed', async () => {
    const role = createRole(db, { url: 'https://example.com/jobs/1' });
    db.prepare("UPDATE roles SET closed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(role.id);

    await handleRoleClosureCheck(db, role.id);

    const updated = getRoleById(db, role.id)!;
    expect(updated.last_checked_at).toBeNull(); // never even attempted a fetch
  });
});

describe('handleRoleClosureCheck — job payload dispatch', () => {
  it('rejects an unknown job kind', async () => {
    const { handleRefreshJob } = await import('./refresh.js');
    await expect(
      handleRefreshJob(db, {
        id: 1,
        topic: 'refresh',
        payload: JSON.stringify({ kind: 'bogus' }),
        status: 'running',
        priority: 0,
        attempts: 0,
        available_at: new Date().toISOString(),
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    ).rejects.toThrow(/Unknown refresh job payload/);
  });
});
