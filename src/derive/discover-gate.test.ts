import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { openDb } from '../db/client.js';
import { listOperationalLogs } from '../db/repositories/operational-logs.js';
import { listSnapshotsForUrl } from '../db/repositories/page-snapshots.js';
import { hashUrl } from '../pages/store.js';
import { gateDiscoveredUrl } from './discover-gate.js';

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;
let server: FixtureServer | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-gate-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('gateDiscoveredUrl', () => {
  it('rejects a posting that is simply gone', async () => {
    server = await startFixtureServer({ '/jobs/1': { status: 404 } });

    // A model asked to find postings will surface stale URLs; each one used
    // to become a role that paid for a full enrichment chain.
    expect(await gateDiscoveredUrl(db, `${server.url}/jobs/1`)).toMatchObject({
      track: false,
      reason: 'http-gone',
    });
  });

  it('rejects a page that says outright it is closed', async () => {
    server = await startFixtureServer({
      '/jobs/1': '<html><body><p>We are no longer accepting applications for this role.</p></body></html>',
    });

    const verdict = await gateDiscoveredUrl(db, `${server.url}/jobs/1`);

    expect(verdict.track).toBe(false);
    expect(verdict).toMatchObject({ reason: 'closure-phrase' });
  });

  it('tracks a live posting', async () => {
    server = await startFixtureServer({
      '/jobs/1': '<html><body><h1>Staff Engineer</h1><p>Apply now — we review every application.</p></body></html>',
    });

    expect(await gateDiscoveredUrl(db, `${server.url}/jobs/1`)).toMatchObject({ track: true, reason: 'open' });
  });

  it('tracks a posting it cannot settle, rather than paying the model to decide', async () => {
    server = await startFixtureServer({ '/jobs/1': '<html><body><p>Some ambiguous page.</p></body></html>' });

    // decideClosure would ask the model here. Paying per candidate to avoid
    // paying per candidate is not a saving, so an undetermined page is
    // tracked exactly as it was before this gate existed.
    expect(await gateDiscoveredUrl(db, `${server.url}/jobs/1`)).toMatchObject({ track: true });
  });

  it('does not lose a real opening to a transient failure', async () => {
    // Port 1 has nothing listening. Losing a genuine posting to a blip is
    // worse than the enrichment it would have cost, and `cm refresh` will
    // catch it later if it really is dead.
    expect(await gateDiscoveredUrl(db, 'http://127.0.0.1:1/jobs/1')).toMatchObject({
      track: true,
      reason: 'unreachable',
    });

    // And it says so: a gate that can no longer reach anything is a broken
    // gate, which would otherwise be invisible while still costing a fetch
    // per candidate.
    expect(listOperationalLogs(db, { action: 'gate-unreachable' })).toHaveLength(1);
  });

  it('records a phrase rejection where it can be found', async () => {
    server = await startFixtureServer({
      '/jobs/1': '<html><body><p>This job has been filled.</p></body></html>',
    });

    await gateDiscoveredUrl(db, `${server.url}/jobs/1`);

    // The phrase list decides alone here, with no model fallback, and its
    // own header warns that a false positive silently closes a live role —
    // so the rejection has to be greppable, not just an event on the
    // company that no command shows by default.
    const [log] = listOperationalLogs(db, { action: 'gate-rejected' });
    expect(log?.severity).toBe('warn');
    expect(log?.context).toContain('this job has been filled');
  });

  it('leaves behind the snapshot the structural fetch will reuse', async () => {
    server = await startFixtureServer({ '/jobs/1': '<html><body><h1>Staff Engineer</h1></body></html>' });
    const url = `${server.url}/jobs/1`;

    await gateDiscoveredUrl(db, url);

    // The gate moves a fetch earlier rather than adding one: enrichment
    // reuses this snapshot while it is inside page_refresh_days.role.
    expect(listSnapshotsForUrl(db, hashUrl(url))).toHaveLength(1);
    expect(server.requests).toEqual(['/jobs/1']);
  });
});
