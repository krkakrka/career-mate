import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Preferences } from '../../config/preferences.js';
import { openDb } from '../../db/client.js';
import { createCompany } from '../../db/repositories/companies.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import { claimNextJob, enqueueJob, listJobs } from '../../db/repositories/jobs.js';
import { createRole, listRoles } from '../../db/repositories/roles.js';
import type { GateVerdict } from '../../derive/discover-gate.js';
import { boardFromRoleUrls } from '../../discover/board.js';
import { listOperationalLogs } from '../../db/repositories/operational-logs.js';
import { applyDiscoveredRoles, discoverViaBoard } from './discover.js';
import { handleNotificationJob } from './notification.js';
import { restoreEnv } from '../../../test/helpers/env.js';

const NO_KEYWORDS: Preferences = {
  titleKeywords: [],
  seniority: null,
  remoteEuRequired: false,
  minSalary: null,
  currency: null,
};

const BACKEND_ONLY: Preferences = { ...NO_KEYWORDS, titleKeywords: ['backend'] };
/** The board path refuses to run without a title filter, so its tests need one. */
const ENGINEER_ONLY: Preferences = { ...NO_KEYWORDS, titleKeywords: ['engineer', 'designer'] };

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-discover-handler-'));
  // Required by CLAUDE.md, and load-bearing twice over: if
  // `boardListedGate` ever regressed to the real gate this suite would
  // fetch over the network and write snapshots into the project's own
  // `.data`; and `handleNotificationJob` reads `settings.json`, which
  // `loadJsonConfig` *creates* when missing.
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
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

    await applyDiscoveredRoles(db, company.id, { roles: [] }, ENGINEER_ONLY, { gate: alwaysOpen });

    const events = listEventsForEntity(db, 'company', company.id);
    const completed = events.find((e) => e.type === 'company.discover_completed');
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!.context!)).toEqual({ candidatesFound: 0, created: 0, skipped: 0, closed: 0, capped: 0 });
  });

  it('enqueues a notification job only when at least one role was created', async () => {
    const companyWithNone = createCompany(db, 'https://none.example.com', 'None Co');
    await applyDiscoveredRoles(db, companyWithNone.id, { roles: [] }, ENGINEER_ONLY, { gate: alwaysOpen });
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
    // Awaited: the handler is async now, and a floating promise turns a
    // rejection into an unhandled rejection rather than a test failure.
    await handleNotificationJob(db, notificationJob!);

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
    const result = await applyDiscoveredRoles(db, company.id, { roles: [{ title: 'E', url }] }, ENGINEER_ONLY, {
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

    expect(result).toEqual({ created: 1, skipped: 1, closed: 1, capped: 0 });
    // `capped` is part of the same partition — a consumer adding the
    // counts up must still reach the candidate total.
    expect(result.created + result.skipped + result.closed + result.capped).toBe(3);
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

    const result = await applyDiscoveredRoles(db, company.id, { roles }, ENGINEER_ONLY, {
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

describe('discoverViaBoard', () => {
  const ASHBY_ROLE = 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245';

  function trackedCompanyOnAshby(): number {
    const company = createCompany(db, 'https://ramp.example.com', 'Ramp');
    createRole(db, { companyId: company.id, url: ASHBY_ROLE });
    return company.id;
  }

  /**
   * A real job row, because `operational_logs.job_id` is a foreign key:
   * logging against an id that does not exist violates it, and
   * `tryRecordOperationalLog` swallows the failure — so the log silently
   * vanishes and the test sees nothing.
   */
  function realJobId(): number {
    return enqueueJob(db, { topic: 'discovery', payload: { kind: 'company-discover', companyId: 1 } }).id;
  }

  it('creates roles from the board listing without touching the model', async () => {
    // `cm discover` pays one sonnet web search per tracked company. A board
    // we can prove from a tracked role URL publishes the whole list free.
    const companyId = trackedCompanyOnAshby();

    const used = await discoverViaBoard(db, companyId, realJobId(), ENGINEER_ONLY, {
      fetchPostings: async () => [
        { title: 'Staff Engineer', url: 'https://jobs.ashbyhq.com/ramp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
        { title: 'Designer', url: 'https://jobs.ashbyhq.com/ramp/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
      ],
    });

    expect(used).toBe(true);
    const urls = listRoles(db, { companyId, includeTerminal: true }).map((role) => role.url);
    expect(urls).toContain('https://jobs.ashbyhq.com/ramp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    expect(urls.length).toBe(3); // the seed role plus the two discovered
  });

  it('does not re-fetch each candidate to ask whether it is open', async () => {
    // Step 31's gate exists because a *model* surfaces dead URLs. A board's
    // own listing cannot, so gating would spend a request per candidate
    // confirming what the publisher just said.
    //
    // Asserted by counting the gate the *caller* would have used: an
    // uninstrumented version of this counted a variable nothing ever
    // incremented, and passed vacuously.
    const companyId = trackedCompanyOnAshby();
    let gateCalls = 0;
    const countingGate = async (): Promise<GateVerdict> => {
      gateCalls++;
      return { track: true, reason: 'open' };
    };

    await applyDiscoveredRoles(
      db,
      companyId,
      { roles: [{ title: 'Staff Engineer', url: 'https://jobs.ashbyhq.com/ramp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }] },
      ENGINEER_ONLY,
      { gate: countingGate },
    );
    expect(gateCalls).toBe(1); // the ordinary path does gate

    gateCalls = 0;
    await discoverViaBoard(db, companyId, realJobId(), ENGINEER_ONLY, {
      fetchPostings: async () => [
        { title: 'Staff Engineer 2', url: 'https://jobs.ashbyhq.com/ramp/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
      ],
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_snapshots').get()).toEqual({ n: 0 });
  });

  it('falls back to the paid search when the board cannot be read', async () => {
    // A board outage must cost a search, never a run.
    const companyId = trackedCompanyOnAshby();

    const used = await discoverViaBoard(db, companyId, realJobId(), ENGINEER_ONLY, {
      fetchPostings: async () => {
        throw new Error('HTTP 503');
      },
    });

    expect(used).toBe(false);
    const logs = listOperationalLogs(db, { action: 'board-listing' });
    expect(logs[0]!.outcome).toBe('failed');
    expect(JSON.parse(logs[0]!.context!).fellBackTo).toBe('web-search');
  });

  it('declines when nothing tracked proves which board the company uses', async () => {
    // Guessing a slug from a company name silently returns another
    // company's postings, and every one would be tracked and enriched.
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    createRole(db, { companyId: company.id, url: 'https://acme.example.com/careers/1' });

    expect(await discoverViaBoard(db, company.id, realJobId(), ENGINEER_ONLY, { fetchPostings: async () => [] })).toBe(false);
  });

  it('records how many postings the board returned', async () => {
    const companyId = trackedCompanyOnAshby();
    await discoverViaBoard(db, companyId, realJobId(), ENGINEER_ONLY, {
      fetchPostings: async () => [{ title: 'Staff Engineer', url: 'https://jobs.ashbyhq.com/ramp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }],
    });

    const logs = listOperationalLogs(db, { action: 'board-listing' });
    expect(JSON.parse(logs[0]!.context!)).toMatchObject({ provider: 'ashby', board: 'ramp', postings: 1 });
  });
});

describe('spend bounds on discovery', () => {
  const ASHBY_ROLE = 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245';

  function company(): number {
    const created = createCompany(db, 'https://ramp.example.com', 'Ramp');
    createRole(db, { companyId: created.id, url: ASHBY_ROLE });
    return created.id;
  }

  function jobId(): number {
    return enqueueJob(db, { topic: 'discovery', payload: { kind: 'company-discover', companyId: 1 } }).id;
  }

  function postings(count: number): { title: string; url: string }[] {
    return Array.from({ length: count }, (_unused, n) => ({
      title: `Engineer ${n}`,
      url: `https://jobs.ashbyhq.com/ramp/${String(n).padStart(8, '0')}-aaaa-4aaa-aaaa-aaaaaaaaaaaa`,
    }));
  }

  it('caps how many roles one run may create', async () => {
    // Every created role chains a structural extraction *and* a
    // sonnet-with-web-search research call, and a board hands over its
    // whole list — 631 postings for Stripe when this was measured. Without
    // a cap, one `cm discover` is an unbounded bill.
    const companyId = company();

    const result = await applyDiscoveredRoles(db, companyId, { roles: postings(50) }, ENGINEER_ONLY, {
      gate: async () => ({ track: true, reason: 'open' }),
      maxNewRoles: 10,
    });

    expect(result.created).toBe(10);
    expect(result.capped).toBe(40);
    expect(listRoles(db, { companyId, includeTerminal: true }).length).toBe(11); // the seed plus ten
  });

  it('refuses the board path when nothing would filter the results', async () => {
    // The shipped default `titleKeywords: []` matches everything, so
    // reading a whole board without a filter is a dump, not discovery. The
    // web search returns a handful by construction.
    let fetched = false;
    const used = await discoverViaBoard(db, company(), jobId(), NO_KEYWORDS, {
      fetchPostings: async () => {
        fetched = true;
        return postings(5);
      },
    });

    expect(used).toBe(false);
    expect(fetched).toBe(false);
    const log = listOperationalLogs(db, { action: 'board-listing' })[0]!;
    expect(JSON.parse(log.context!).reason).toMatch(/titleKeywords is empty/);
  });

  it('falls back to the search when the board lists nothing', async () => {
    // A legacy board left up after an ATS migration returns `jobs: []`.
    // Treating that as a result would mean such a company gets nothing from
    // either path, forever.
    const used = await discoverViaBoard(db, company(), jobId(), ENGINEER_ONLY, { fetchPostings: async () => [] });

    expect(used).toBe(false);
    expect(JSON.parse(listOperationalLogs(db, { action: 'board-listing' })[0]!.context!).fellBackTo).toBe(
      'web-search',
    );
  });

  it('reads the board from the most recently added role, not the most recently touched', async () => {
    // A refresh re-stamps `updated_at`, so ordering by it would let an old
    // posting on the company's previous ATS outrank a newly added one and
    // pin discovery to a list that no longer grows.
    const created = createCompany(db, 'https://moved.example.com', 'Moved');
    const old = createRole(db, { companyId: created.id, url: ASHBY_ROLE });
    const recent = createRole(db, { companyId: created.id, url: 'https://boards.greenhouse.io/newco/jobs/123' });
    db.prepare("UPDATE roles SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);
    db.prepare("UPDATE roles SET created_at = '2026-01-01T00:00:00.000Z', updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(recent.id);

    let seen: string | undefined;
    await discoverViaBoard(db, created.id, jobId(), ENGINEER_ONLY, {
      fetchPostings: async (board) => {
        seen = board.board;
        return [];
      },
    });

    expect(seen).toBe('newco');
  });
});
