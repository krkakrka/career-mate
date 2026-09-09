import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Preferences } from '../../config/preferences.js';
import { openDb } from '../../db/client.js';
import { createCompany } from '../../db/repositories/companies.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import { claimNextJob } from '../../db/repositories/jobs.js';
import { createRole, listRoles } from '../../db/repositories/roles.js';
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

describe('applyDiscoveredRoles', () => {
  it('creates a role for each matching, non-duplicate candidate and enqueues structural-fetch enrichment', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Senior Backend Engineer', url: 'https://acme.example.com/jobs/1' }] },
      NO_KEYWORDS,
    );

    expect(result).toEqual({ created: 1, skipped: 0 });
    const roles = listRoles(db, { companyId: company.id });
    expect(roles).toHaveLength(1);
    expect(roles[0]!.url).toBe('https://acme.example.com/jobs/1');

    const job = claimNextJob(db, 'enrichment');
    expect(job).toBeDefined();
    expect(JSON.parse(job!.payload)).toEqual({ kind: 'role-structural', roleId: roles[0]!.id });

    const events = listEventsForEntity(db, 'role', roles[0]!.id);
    expect(events.some((e) => e.type === 'role.discovered')).toBe(true);
  });

  it('skips a candidate whose title does not match configured preferences', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Product Designer', url: 'https://acme.example.com/jobs/2' }] },
      BACKEND_ONLY,
    );

    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(listRoles(db, { companyId: company.id })).toHaveLength(0);
  });

  it('skips a candidate with no url or a non-http(s) url, without throwing', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Backend Engineer', url: null }, { title: 'Backend Engineer', url: 'not a url' }] },
      NO_KEYWORDS,
    );

    expect(result).toEqual({ created: 0, skipped: 2 });
  });

  it('skips (does not duplicate) a candidate matching an already-tracked role at the same company', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/3' });

    const result = applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Backend Engineer', url: 'https://acme.example.com/jobs/3' }] },
      NO_KEYWORDS,
    );

    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(listRoles(db, { companyId: company.id })).toHaveLength(1);
  });

  it('records a company.discover_completed event summarizing the run, even with zero candidates', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    applyDiscoveredRoles(db, company.id, { roles: [] }, NO_KEYWORDS);

    const events = listEventsForEntity(db, 'company', company.id);
    const completed = events.find((e) => e.type === 'company.discover_completed');
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!.context!)).toEqual({ candidatesFound: 0, created: 0, skipped: 0 });
  });

  it('enqueues a notification job only when at least one role was created', () => {
    const companyWithNone = createCompany(db, 'https://none.example.com', 'None Co');
    applyDiscoveredRoles(db, companyWithNone.id, { roles: [] }, NO_KEYWORDS);
    expect(claimNextJob(db, 'notification')).toBeUndefined();

    const companyWithOne = createCompany(db, 'https://one.example.com', 'One Co');
    applyDiscoveredRoles(
      db,
      companyWithOne.id,
      { roles: [{ title: 'Backend Engineer', url: 'https://one.example.com/jobs/1' }] },
      NO_KEYWORDS,
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

  it('records exactly one company.discover_completed event even after the notification job runs (no duplicate from the notification path)', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    applyDiscoveredRoles(
      db,
      company.id,
      { roles: [{ title: 'Backend Engineer', url: 'https://acme.example.com/jobs/1' }] },
      NO_KEYWORDS,
    );

    const notificationJob = claimNextJob(db, 'notification');
    expect(notificationJob).toBeDefined();
    handleNotificationJob(db, notificationJob!);

    const events = listEventsForEntity(db, 'company', company.id);
    expect(events.filter((e) => e.type === 'company.discover_completed')).toHaveLength(1);
  });

  it('handles a mix of matching and non-matching candidates in one run', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    const result = applyDiscoveredRoles(
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
    );

    expect(result).toEqual({ created: 2, skipped: 1 });
  });
});
