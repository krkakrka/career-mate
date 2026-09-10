import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client.js';
import { createCompany, getCompanyById, listCompanies } from '../../db/repositories/companies.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import type { JobRecord } from '../../db/repositories/jobs.js';
import { createRole, getRoleById } from '../../db/repositories/roles.js';
import { handleEnrichmentJob, resolveRoleCompany } from './enrichment.js';

function fakeJob(payload: unknown): JobRecord {
  return {
    id: 1,
    topic: 'enrichment',
    payload: JSON.stringify(payload),
    status: 'running',
    priority: 0,
    attempts: 0,
    available_at: new Date().toISOString(),
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-enrichment-handler-'));
  // These handlers snapshot pages through the page store, which resolves
  // its files via getDataDir(). Without this, any fixture route that
  // actually served a 200 would write into the project's real ./.data.
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  process.env.CM_DATA_DIR = originalDataDir;
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveRoleCompany', () => {
  it('creates and attaches a new company when companyUrl is a valid http(s) URL', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/1' });
    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: 'https://acme.example.com' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).not.toBeNull();
    const company = getCompanyById(db, updated.company_id!)!;
    expect(company.url).toBe('https://acme.example.com');
    expect(company.name).toBe('Acme Corp');

    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.some((e) => e.type === 'role.company_resolved')).toBe(true);
  });

  it('leaves the role unresolved when no companyUrl was extracted', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/2' });
    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: null });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBeNull();
    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.some((e) => e.type === 'role.company_unresolved')).toBe(true);
  });

  it('leaves the role unresolved (not a bogus company) when the extracted companyUrl is not a valid http(s) URL', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/3' });
    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: 'not a url at all' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBeNull();
    expect(listCompanies(db)).toHaveLength(0);

    const events = listEventsForEntity(db, 'role', role.id);
    const unresolvedEvent = events.find((e) => e.type === 'role.company_unresolved');
    expect(unresolvedEvent).toBeDefined();
    expect(JSON.parse(unresolvedEvent!.context!).reason).toMatch(/not a valid http/);
  });

  it('attaches to an existing matching company instead of creating a duplicate', () => {
    const existing = createCompany(db, 'https://acme.example.com', 'Acme Corp');
    const role = createRole(db, { url: 'https://example.com/jobs/4' });

    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: 'https://acme.example.com' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBe(existing.id);
    expect(listCompanies(db)).toHaveLength(1);
  });

  it('does not overwrite a company already attached by a concurrent run (attachCompanyIfUnresolved race guard)', () => {
    const firstResolution = createCompany(db, 'https://first.example.com', 'First Co');
    const role = createRole(db, { url: 'https://example.com/jobs/5' });
    // Simulates another process (e.g. an overlapping rerun-enrichment)
    // already resolving this role's company between handleRoleStructural's
    // fresh re-read and this call.
    db.prepare('UPDATE roles SET company_id = ? WHERE id = ?').run(firstResolution.id, role.id);

    resolveRoleCompany(db, role.id, { companyName: 'Second Co', companyUrl: 'https://second.example.com' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBe(firstResolution.id);

    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.some((e) => e.type === 'role.company_resolution_lost_race')).toBe(true);
  });
});

describe('company-wlb job — no urlTemplate configured (the shipped default)', () => {
  it('skips gracefully with a clear event instead of attempting doomed browser automation, no live calls', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    // No live claude -p / Playwright call should happen here at all — WLB
    // is login-gated, so without a real urlTemplate in sources.json there
    // is nothing reachable to research. This must stay fast and free.
    const start = Date.now();
    await handleEnrichmentJob(db, fakeJob({ kind: 'company-wlb', companyId: company.id }));
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);

    const updated = getCompanyById(db, company.id)!;
    expect(updated.wlb_score).toBeNull();

    const events = listEventsForEntity(db, 'company', company.id);
    const skipped = events.find((e) => e.type === 'company.wlb_skipped');
    expect(skipped).toBeDefined();
    expect(JSON.parse(skipped!.context!).reason).toMatch(/urlTemplate/);
  });
});
