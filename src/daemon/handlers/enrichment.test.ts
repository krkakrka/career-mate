import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client.js';
import { createCompany, getCompanyById, listCompanies } from '../../db/repositories/companies.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import { createRole, getRoleById } from '../../db/repositories/roles.js';
import { resolveRoleCompany } from './enrichment.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-enrichment-handler-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
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
