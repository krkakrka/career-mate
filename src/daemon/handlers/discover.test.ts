import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Preferences } from '../../config/preferences.js';
import { openDb } from '../../db/client.js';
import { createCompany } from '../../db/repositories/companies.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import { claimNextJob, listJobs } from '../../db/repositories/jobs.js';
import { createRole, listRoles } from '../../db/repositories/roles.js';
import type { GateVerdict } from '../../derive/discover-gate.js';
import { applyDiscoveredRoles } from './discover.js';
import { handleNotificationJob } from './notification.js';

const NO_KEYWORDS: Preferences = {
  titleKeywords: [],
  seniority: null,
  remoteEuRequired: false,
  minSalary: null,
};

const BACKEND_ONLY: Preferences = { ...NO_KEYWORDS, titleKeywords: ['backend'] };

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-discover-handler-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** These cover filtering and dedupe, not the network — the real gate has its own suite. */
const alwaysOpen = async (): Promise<GateVerdict> => ({ track: true, reason: 'open' });

describe('applyDiscoveredRoles', () => {
  it('creates a role for each matching, non-duplicate candidate and enqueues structural-fetch enrichment', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Senior Backend Engineer', url: 'https://acme.example.com/jobs/1' }] },
      NO_KEYWORDS,
      { gate: alwaysOpen },
    );

    expect(result).toMatchObject({ created: 1, skipped: 0 });
    const roles = listRoles(db, { companyId: company.id });
    expect(roles).toHaveLength(1);
    expect(roles[0]!.url).toBe('https://acme.example.com/jobs/1');

    const job = claimNextJob(db, 'enrichment');
    expect(job).toBeDefined();
    expect(JSON.parse(job!.payload)).toEqual({ kind: 'role-structural', roleId: roles[0]!.id });

    const events = listEventsForEntity(db, 'role', roles[0]!.id);
    expect(events.some((e) => e.type === 'role.discovered')).toBe(true);
  });

  it('skips a candidate whose title does not match configured preferences', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Product Designer', url: 'https://acme.example.com/jobs/2' }] },
      BACKEND_ONLY,
      { gate: alwaysOpen },
    );

    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(listRoles(db, { companyId: company.id })).toHaveLength(0);
  });

  it('skips a candidate with no url or a non-http(s) url, without throwing', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Backend Engineer', url: null }, { title: 'Backend Engineer', url: 'not a url' }] },
      NO_KEYWORDS,
      { gate: alwaysOpen },
    );

    expect(result).toMatchObject({ created: 0, skipped: 2 });
  });

  it('skips (does not duplicate) a candidate matching an already-tracked role at the same company', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/3' });

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Backend Engineer', url: 'https://acme.example.com/jobs/3' }] },
      NO_KEYWORDS,
      { gate: alwaysOpen },
    );

    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(listRoles(db, { companyId: company.id })).toHaveLength(1);
  });

  it('records a company.discover_completed event summarizing the run, even with zero candidates', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    await applyDiscoveredRoles(db, company.id, { roles: [] }, NO_KEYWORDS, { gate: alwaysOpen });

    const events = listEventsForEntity(db, 'company', company.id);
    const completed = events.find((e) => e.type === 'company.discover_completed');
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!.context!)).toEqual({ candidatesFound: 0, created: 0, skipped: 0, closed: 0 });
  });

  it('enqueues a notification job only when at least one role was created', async () => {
    const companyWithNone = createCompany(db, 'https://none.example.com', 'None Co');
    await applyDiscoveredRoles(db, companyWithNone.id, { roles: [] }, NO_KEYWORDS, { gate: alwaysOpen });
    expect(claimNextJob(db, 'notification')).toBeUndefined();

    const companyWithOne = createCompany(db, 'https://one.example.com', 'One Co');
    await applyDiscoveredRoles(
      db,
      companyWithOne.id,
      { roles: [{ title: 'Backend Engineer', url: 'https://one.example.com/jobs/1' }] },
      NO_KEYWORDS,
      { gate: alwaysOpen },
    );
    const notificationJob = claimNextJob(db, 'notification');
    expect(notificationJob).toBeDefined();
    const notificationPayload = JSON.parse(notificationJob!.payload) as { entityType: string; entityId: number; eventType: string };
    expect(notificationPayload).toMatchObject({ entityType: 'company', entityId: companyWithOne.id });
    // Must NOT reuse 'company.discover_completed' — handleNotificationJob
    // records its own event from this payload's eventType, so reusing the
    // summary event's own type would double-record one event per run.
    expect(notificationPayload.eventType).not.toBe('company.discover_completed');
    expect(notificationPayload.eventType).toBe('company.roles_discovered');
  });

  it('records exactly one company.discover_completed event even after the notification job runs (no duplicate from the notification path)', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Backend Engineer', url: 'https://acme.example.com/jobs/1' }] },
      NO_KEYWORDS,
      { gate: alwaysOpen },
    );

    const notificationJob = claimNextJob(db, 'notification');
    expect(notificationJob).toBeDefined();
    handleNotificationJob(db, notificationJob!);

    const events = listEventsForEntity(db, 'company', company.id);
    expect(events.filter((e) => e.type === 'company.discover_completed')).toHaveLength(1);
  });

  it('handles a mix of matching and non-matching candidates in one run', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      {
        roles: [
          { title: 'Senior Backend Engineer', url: 'https://acme.example.com/jobs/a' },
          { title: 'Product Designer', url: 'https://acme.example.com/jobs/b' },
          { title: 'Backend Platform Engineer', url: 'https://acme.example.com/jobs/c' },
        ],
      },
      BACKEND_ONLY,
      { gate: alwaysOpen },
    );

    expect(result).toMatchObject({ created: 2, skipped: 1 });
  });
});

describe('gating', () => {
  it('does not create a role for a posting the gate rejects', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const closed = async (): Promise<GateVerdict> => ({
      track: false,
      reason: 'http-gone',
      detail: 'page returned HTTP 404',
    });

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Engineer', url: 'https://acme.example.com/jobs/dead' }] },
      NO_KEYWORDS,
      { gate: closed },
    );

    // The cheapest moment to find out is before the role exists: creating
    // it immediately queues a structural extraction and a research call.
    expect(result).toMatchObject({ created: 0, closed: 1 });
    expect(listRoles(db, { companyId: company.id })).toHaveLength(0);
    expect(listJobs(db).filter((job) => job.topic === 'enrichment')).toHaveLength(0);
  });

  it('records why a candidate was rejected, so a wrong gate is visible', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const closed = async (): Promise<GateVerdict> => ({
      track: false,
      reason: 'closure-phrase',
      detail: 'page text contains "this job has been filled"',
    });

    await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Engineer', url: 'https://acme.example.com/jobs/filled' }] },
      NO_KEYWORDS,
      { gate: closed },
    );

    const event = listEventsForEntity(db, 'company', company.id).find(
      (e) => e.type === 'company.discover_candidate_closed',
    );
    expect(JSON.parse(event!.context!)).toMatchObject({ reason: 'closure-phrase' });
  });

  it('keeps going after rejecting one candidate', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const rejectDead = async (_db: unknown, url: string): Promise<GateVerdict> =>
      url.includes('dead') ? { track: false, reason: 'http-gone', detail: 'gone' } : { track: true, reason: 'open' };

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      {
        roles: [
          { title: 'Dead Engineer', url: 'https://acme.example.com/jobs/dead' },
          { title: 'Live Engineer', url: 'https://acme.example.com/jobs/live' },
        ],
      },
      NO_KEYWORDS,
      { gate: rejectDead },
    );

    expect(result).toMatchObject({ created: 1, closed: 1 });
    expect(listRoles(db, { companyId: company.id })).toHaveLength(1);
  });
});

describe('gate ordering and budget', () => {
  it('does not fetch a candidate it already tracks', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const url = 'https://acme.example.com/jobs/1';
    createRole(db, { companyId: company.id, url });

    let gateCalls = 0;
    const counting = async (): Promise<GateVerdict> => {
      gateCalls += 1;
      return { track: true, reason: 'open' };
    };

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Engineer', url }] },
      NO_KEYWORDS,
      { gate: counting },
    );

    // Re-discovering already-tracked roles is the common path, so gating
    // before the dedupe made every run pay an HTTP fetch and a snapshot row
    // per tracked role — inverting the saving the gate exists for.
    expect(gateCalls).toBe(0);
    expect(result).toMatchObject({ created: 0, skipped: 1, closed: 0 });
  });

  it('counts a duplicate as skipped, never as a closure', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const url = 'https://acme.example.com/jobs/1';
    createRole(db, { companyId: company.id, url });

    // A tracked role whose page has since closed is still a duplicate.
    const closed = async (): Promise<GateVerdict> => ({ track: false, reason: 'http-gone', detail: 'gone' });
    const result = await applyDiscoveredRoles(db, company.id, { roles: [{ title: 'E', url }] }, NO_KEYWORDS, {
      gate: closed,
    });

    expect(result).toMatchObject({ skipped: 1, closed: 0 });
  });

  it('keeps created, skipped and closed disjoint, so they can be added up', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const rejectDead = async (_db: unknown, url: string): Promise<GateVerdict> =>
      url.includes('dead') ? { track: false, reason: 'http-gone', detail: 'gone' } : { track: true, reason: 'open' };

    const result = await applyDiscoveredRoles(
      db,
      company.id,
      {
        roles: [
          { title: 'Live', url: 'https://acme.example.com/jobs/live' },
          { title: 'Dead', url: 'https://acme.example.com/jobs/dead' },
          { title: 'Bad URL', url: 'not-a-url' },
        ],
      },
      NO_KEYWORDS,
      { gate: rejectDead },
    );

    expect(result).toEqual({ created: 1, skipped: 1, closed: 1 });
    expect(result.created + result.skipped + result.closed).toBe(3);
  });

  it('stops gating once its time budget is spent, rather than overrunning the stale-job sweep', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    let gateCalls = 0;
    const slowGate = async (): Promise<GateVerdict> => {
      gateCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { track: true, reason: 'open' };
    };

    const roles = Array.from({ length: 8 }, (_unused, index) => ({
      title: `Engineer ${index}`,
      url: `https://acme.example.com/jobs/${index}`,
    }));

    const result = await applyDiscoveredRoles(db, company.id, { roles }, NO_KEYWORDS, {
      gate: slowGate,
      gateBudgetMs: 30,
    });

    // Gating is N serial fetches at up to 15s each; without a budget a
    // company returning a hundred candidates on slow hosts would exceed
    // stale_running_job_minutes and get requeued into a second paid web
    // search. Past the budget, candidates are tracked ungated — the
    // behaviour before this gate existed.
    expect(gateCalls).toBeLessThan(roles.length);
    expect(result.created).toBe(roles.length);
  });
});
