import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { openDb } from '../db/client.js';
import { createCompany } from '../db/repositories/companies.js';
import { createRole, getRoleById } from '../db/repositories/roles.js';
import { upsertDerivation } from '../db/repositories/derivations.js';
import { listJobs } from '../db/repositories/jobs.js';
import { snapshotPage } from '../pages/store.js';
import { researchRecipeVersion, structuralRecipeVersion } from './recipes.js';
import { roleResearchSourceKey } from './role-research-key.js';
import type { StalenessReason } from './staleness.js';
import type { FieldGroupStatus } from './view-staleness.js';
import { companyFieldGroupStatus, enqueueRecomputes, roleFieldGroupStatus } from './view-staleness.js';

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;
let server: FixtureServer | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-view-staleness-'));
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

describe('companyFieldGroupStatus', () => {
  it('marks a never-computed group as pending, not stale', () => {
    const company = createCompany(db, 'https://example.com');

    const groups = companyFieldGroupStatus(db, company);

    // A freshly added entity has computed nothing yet; that is a job that
    // has not run, not a value on screen known to be out of date.
    expect(groups.map((group) => group.marker)).toEqual(['(pending)', '(pending)']);
    expect(groups.map((group) => group.kind)).toEqual(['company_structural', 'company_research']);
  });

  it('marks a group stale once a newer snapshot no longer matches what it was derived from', async () => {
    let body = '<html><head><title>Example Co</title></head><body>We build things.</body></html>';
    server = await startFixtureServer({ '/': () => body });
    const company = createCompany(db, `${server.url}/`);

    const first = await snapshotPage(db, company.url, { kind: 'company' });
    upsertDerivation(db, {
      entityType: 'company',
      entityId: company.id,
      kind: 'company_structural',
      sourceKey: first.text_hash!,
      recipeVersion: structuralRecipeVersion('company'),
    });

    expect(kinds(companyFieldGroupStatus(db, company))).not.toContain('company_structural');

    body = '<html><head><title>Example Co</title></head><body>We build OTHER things.</body></html>';
    await snapshotPage(db, company.url, { kind: 'company', force: true });

    const stale = companyFieldGroupStatus(db, company).find((group) => group.kind === 'company_structural');
    expect(stale).toMatchObject({ reason: 'source-changed', marker: '(stale)' });
  });
});

function kinds(groups: { kind: string }[]): string[] {
  return groups.map((group) => group.kind);
}

describe('enqueueRecomputes', () => {
  it('leaves one job per group however many times the entity is read', () => {
    const company = createCompany(db, 'https://example.com');
    const groups = companyFieldGroupStatus(db, company);

    expect(enqueueRecomputes(db, 'company', company.id, groups)).toBe(1);
    expect(enqueueRecomputes(db, 'company', company.id, groups)).toBe(0);
    expect(enqueueRecomputes(db, 'company', company.id, groups)).toBe(0);

    // Reading is what triggers a recompute, so a `show` in a loop must not
    // queue a job per read.
    expect(listJobs(db)).toHaveLength(1);
  });

  it('will not research an entity that has not been extracted yet', () => {
    const company = createCompany(db, 'https://example.com');

    enqueueRecomputes(db, 'company', company.id, companyFieldGroupStatus(db, company));

    // A research call is handed the entity's *extracted* name and
    // description. Running it first would search the web for
    // {"name":null,"description":null} — a paid call on an empty question,
    // whose context hash then differs from the real one, so the proper call
    // that follows isn't even skipped. Two paid calls, the first on garbage.
    const queued = listJobs(db).map((job) => JSON.parse(job.payload).kind);
    expect(queued).toEqual(['company-structural']);
  });

  it('researches once the structural extraction it reads from exists', () => {
    const company = createCompany(db, 'https://example.com');
    upsertDerivation(db, {
      entityType: 'company',
      entityId: company.id,
      kind: 'company_structural',
      sourceKey: 'text-hash',
      recipeVersion: 'recipe',
    });

    enqueueRecomputes(db, 'company', company.id, companyFieldGroupStatus(db, company));

    expect(listJobs(db).map((job) => JSON.parse(job.payload).kind)).toContain('company-research');
  });
});

describe('the recompute floor', () => {
  it('rate-limits a changed page, but never a changed recipe', () => {
    const company = createCompany(db, 'https://example.com');
    upsertDerivation(db, {
      entityType: 'company',
      entityId: company.id,
      kind: 'company_structural',
      sourceKey: 'text-hash',
      recipeVersion: 'recipe',
    });

    const floorMs = 60 * 60 * 1000;
    const group = (reason: StalenessReason): FieldGroupStatus[] => [
      { kind: 'company_structural', marker: '(stale)', reason },
    ];

    // Page churn ("Posted 3 days ago", applicant counters) would otherwise
    // queue a paid extraction on every single read.
    expect(enqueueRecomputes(db, 'company', company.id, group('source-changed'), floorMs)).toBe(0);

    // An edited prompt is a deliberate one-off act whose whole point is
    // that it takes effect — rate-limiting it meant nothing happened for an
    // hour, with no indication why.
    expect(enqueueRecomputes(db, 'company', company.id, group('recipe-changed'), floorMs)).toBe(1);
  });
});

describe('roleFieldGroupStatus — role_research', () => {
  it('reports a just-researched role as fresh rather than stale forever', async () => {
    // The handler keys `role_research` on the context *and the prefill*;
    // the read path used to key it on the context alone. Two different
    // strings hash differently every time, so `cm roles show` suffixed
    // Salary/Equity/Remote-EU with `(stale)` on every read and
    // `enqueueRecomputes` queued a job that then did nothing — exactly the
    // failure research-context.ts's header warns about.
    server = await startFixtureServer({
      '/jobs/1': '<html><body><h1>Staff Engineer</h1><p>We build things.</p></body></html>',
    });
    const role = createRole(db, { url: `${server.url}/jobs/1` });
    await snapshotPage(db, role.url, { kind: 'role' });

    const fresh = getRoleById(db, role.id)!;
    upsertDerivation(db, {
      entityType: 'role',
      entityId: role.id,
      kind: 'role_research',
      sourceKey: roleResearchSourceKey(db, fresh),
      recipeVersion: researchRecipeVersion('role'),
      model: 'fake',
      costUsd: 0,
      inputTokens: null,
      outputTokens: null,
    });

    const research = roleFieldGroupStatus(db, fresh).find((group) => group.kind === 'role_research');
    expect(research?.marker).toBeUndefined();

    // `role_structural` is legitimately pending here, so scope the claim:
    // nothing should ask to *re-research* a role nothing has changed.
    enqueueRecomputes(db, 'role', role.id, roleFieldGroupStatus(db, fresh));
    const kinds = listJobs(db, {}).map((job) => (JSON.parse(job.payload) as { kind: string }).kind);
    expect(kinds).not.toContain('role-research');
  });
});
