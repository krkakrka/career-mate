import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;

function expectNoRawCrash(stderr: string): void {
  expect(stderr).not.toMatch(/\bat\s+\S+\s+\(/);
  expect(stderr).not.toMatch(/\bTypeError\b|\bReferenceError\b/);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-recruiters-cli-'));
  const addCompany = runCli(['companies', 'add', 'https://example.com'], { dataDir });
  expect(addCompany.exitCode).toBe(0);
  const addRole = runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
  expect(addRole.exitCode).toBe(0);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm recruiters ping', () => {
  it('records a contact and it shows up in list', () => {
    const ping = runCli(
      ['recruiters', 'ping', '1', '--name', 'Jane Recruiter', '--channel', 'LinkedIn', '--link', 'https://linkedin.com/x'],
      { dataDir },
    );
    expect(ping.exitCode).toBe(0);
    expect(ping.stdout).toContain('Recorded recruiter contact #1');

    const list = runCli(['recruiters', 'list'], { dataDir });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('Jane Recruiter');
    expect(list.stdout).toContain('LinkedIn');
  });

  it('rejects pinging for an unknown role, cleanly', () => {
    const result = runCli(['recruiters', 'ping', '999', '--name', 'Someone'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/role #999 not found/i);
    expectNoRawCrash(result.stderr);
  });
});

describe('cm recruiters respond', () => {
  it('marks a contact as responded', () => {
    runCli(['recruiters', 'ping', '1', '--name', 'Jane'], { dataDir });
    const respond = runCli(['recruiters', 'respond', '1'], { dataDir });
    expect(respond.exitCode).toBe(0);
    expect(respond.stdout).toMatch(/responded:/);
  });

  it('rejects responding to an unknown contact, cleanly (not a raw stack trace)', () => {
    const result = runCli(['recruiters', 'respond', '999'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/recruiter contact #999 not found/i);
    expectNoRawCrash(result.stderr);
  });
});

describe('cm recruiters list', () => {
  it('says so when there are no contacts', () => {
    const result = runCli(['recruiters', 'list'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no recruiter contacts/i);
  });

  it('filters by --role', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/2', '--company', '1'], { dataDir });
    runCli(['recruiters', 'ping', '1', '--name', 'ForRole1'], { dataDir });
    runCli(['recruiters', 'ping', '2', '--name', 'ForRole2'], { dataDir });

    const result = runCli(['recruiters', 'list', '--role', '1'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ForRole1');
    expect(result.stdout).not.toContain('ForRole2');
  });

  it('filters by --overdue, respecting settings.json recruiter_nudge_days', () => {
    const dbPath = path.join(dataDir, 'career-mate.db');
    runCli(['recruiters', 'ping', '1', '--name', 'RecentContact'], { dataDir });

    // Backdate the contact past settings.json's default recruiter_nudge_days (7).
    const db = openDb(dbPath);
    db.exec("UPDATE recruiter_contacts SET contacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days')");
    db.close();

    const overdue = runCli(['recruiters', 'list', '--overdue'], { dataDir });
    expect(overdue.exitCode).toBe(0);
    expect(overdue.stdout).toContain('RecentContact');

    const notOverdue = runCli(['recruiters', 'list'], { dataDir });
    expect(notOverdue.stdout).toContain('RecentContact'); // still listed without the filter
  });
});
