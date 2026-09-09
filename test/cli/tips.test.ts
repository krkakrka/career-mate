import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { createCompany } from '../../src/db/repositories/companies.js';
import { createRole } from '../../src/db/repositories/roles.js';
import { createCompanyTips, createRoleTips } from '../../src/db/repositories/tips.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-tips-cli-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm tips — error paths (no live claude -p call reached)', () => {
  it('rejects an unknown role id', () => {
    const result = runCli(['tips', '999'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('rejects a role whose company has not resolved yet', () => {
    const addCompany = runCli(['companies', 'add', 'https://example.com'], { dataDir });
    expect(addCompany.exitCode).toBe(0);
    const addRole = runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    expect(addRole.exitCode).toBe(0);

    // Company IS resolved here (explicit --company was given) — so instead
    // simulate the "structural fetch hasn't resolved a company yet" case
    // directly: add a role without --company in an isolated dir where the
    // daemon never runs (no allowDaemonAutostart), so company_id stays null.
    const secondDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-tips-cli-unresolved-'));
    try {
      const addUnresolved = runCli(['roles', 'add', 'https://example.com/jobs/2'], { dataDir: secondDataDir });
      expect(addUnresolved.exitCode).toBe(0);

      const result = runCli(['tips', '1'], { dataDir: secondDataDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/company.*(hasn't been resolved|not.*resolved)/i);
    } finally {
      fs.rmSync(secondDataDir, { recursive: true, force: true });
    }
  });
});

describe('cm tips — shows previously generated tips without re-researching (no live claude -p call reached)', () => {
  it('prints existing tips immediately when they already exist, and does not enqueue fresh research', () => {
    const dbPath = path.join(dataDir, 'career-mate.db');
    const db = openDb(dbPath);
    const company = createCompany(db, 'https://example.com', 'Example Co');
    const role = createRole(db, { companyId: company.id, url: 'https://example.com/jobs/1' });
    createCompanyTips(db, company.id, 'Existing company tips content', [{ url: 'https://a.com', title: 'A' }]);
    createRoleTips(db, role.id, 'Existing role tips content', [{ url: 'https://b.com', title: 'B' }]);
    db.close();

    const result = runCli(['tips', String(role.id)], { dataDir }); // no allowDaemonAutostart — must not need it
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('showing previously generated tips');
    expect(result.stdout).toContain('Existing company tips content');
    expect(result.stdout).toContain('Existing role tips content');
    expect(result.stdout).toContain('https://a.com');
    expect(result.stdout).toContain('https://b.com');

    const afterDb = openDb(dbPath);
    const jobCount = afterDb.prepare("SELECT COUNT(*) as c FROM jobs WHERE topic = 'tips'").get() as { c: number };
    afterDb.close();
    expect(jobCount.c).toBe(0); // no research job was enqueued
  });
});
