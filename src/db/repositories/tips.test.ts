import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.js';
import { createCompany } from './companies.js';
import { createRole } from './roles.js';
import { createCompanyTips, createRoleTips, getFreshCompanyTips, getLatestRoleTips } from './tips.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-tips-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createCompanyTips / getFreshCompanyTips', () => {
  it('returns undefined when no company tips exist yet', () => {
    const company = createCompany(db, 'https://example.com');
    expect(getFreshCompanyTips(db, company.id, 30)).toBeUndefined();
  });

  it('returns a just-created record within the freshness window', () => {
    const company = createCompany(db, 'https://example.com');
    const created = createCompanyTips(db, company.id, 'Some tips', [{ url: 'https://a.com', title: 'A' }]);

    const fresh = getFreshCompanyTips(db, company.id, 30);
    expect(fresh?.id).toBe(created.id);
    expect(fresh?.content).toBe('Some tips');
    expect(JSON.parse(fresh!.sources)).toEqual([{ url: 'https://a.com', title: 'A' }]);
  });

  it('does not return a record older than the freshness window', () => {
    const company = createCompany(db, 'https://example.com');
    const created = createCompanyTips(db, company.id, 'Old tips', []);
    // Backdate it past the cutoff.
    db.prepare("UPDATE tips SET generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE id = ?").run(
      created.id,
    );

    expect(getFreshCompanyTips(db, company.id, 30)).toBeUndefined();
  });

  it('returns the most recent record when multiple exist', () => {
    const company = createCompany(db, 'https://example.com');
    createCompanyTips(db, company.id, 'First', []);
    db.exec("UPDATE tips SET generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')");
    const second = createCompanyTips(db, company.id, 'Second', []);

    const fresh = getFreshCompanyTips(db, company.id, 30);
    expect(fresh?.id).toBe(second.id);
    expect(fresh?.content).toBe('Second');
  });

  it('scopes by company — does not return another company\'s tips', () => {
    const companyA = createCompany(db, 'https://a.example.com');
    const companyB = createCompany(db, 'https://b.example.com');
    createCompanyTips(db, companyA.id, 'A tips', []);

    expect(getFreshCompanyTips(db, companyB.id, 30)).toBeUndefined();
  });
});

describe('createRoleTips / getLatestRoleTips', () => {
  it('returns undefined when no role tips exist yet', () => {
    const company = createCompany(db, 'https://example.com');
    const role = createRole(db, { companyId: company.id, url: 'https://example.com/jobs/1' });
    expect(getLatestRoleTips(db, role.id)).toBeUndefined();
  });

  it('returns the most recently created role tips', () => {
    const company = createCompany(db, 'https://example.com');
    const role = createRole(db, { companyId: company.id, url: 'https://example.com/jobs/1' });
    createRoleTips(db, role.id, 'First', []);
    db.exec("UPDATE tips SET generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')");
    const second = createRoleTips(db, role.id, 'Second', [{ url: 'https://b.com', title: 'B' }]);

    const latest = getLatestRoleTips(db, role.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.content).toBe('Second');
  });
});
