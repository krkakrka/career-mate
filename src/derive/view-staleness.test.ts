import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { openDb } from '../db/client.js';
import { createCompany } from '../db/repositories/companies.js';
import { upsertDerivation } from '../db/repositories/derivations.js';
import { listJobs } from '../db/repositories/jobs.js';
import { snapshotPage } from '../pages/store.js';
import { recipeVersion } from './keys.js';
import { companyFieldGroupStatus, enqueueRecomputes } from './view-staleness.js';

const structuralScript = fileURLToPath(new URL('../enrichment/scripts/extract-structural.sh', import.meta.url));

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
      recipeVersion: recipeVersion(structuralScript),
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
