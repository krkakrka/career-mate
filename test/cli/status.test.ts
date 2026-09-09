import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-status-cli-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm status', () => {
  it('shows a full digest on an empty database', () => {
    const result = runCli(['status'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pipeline status:');
    expect(result.stdout).toContain('new: 0');
    expect(result.stdout).toContain('Stale roles');
    expect(result.stdout).toContain('Recruiter contacts overdue');
    expect(result.stdout).toContain('Ready to reapply: 0');
    expect(result.stdout).toContain('Reapply cooldown still active: 0');
  });

  it('categorizes a seeded stale role, an overdue recruiter contact, and a ready-to-reapply role', () => {
    const addCompany = runCli(['companies', 'add', 'https://example.com'], { dataDir });
    expect(addCompany.exitCode).toBe(0);
    const addRole = runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    expect(addRole.exitCode).toBe(0);
    const addStaleActiveRole = runCli(['roles', 'add', 'https://example.com/jobs/2', '--company', '1'], { dataDir });
    expect(addStaleActiveRole.exitCode).toBe(0);
    const ping = runCli(
      ['recruiters', 'ping', '1', '--name', 'Jane Recruiter', '--channel', 'LinkedIn'],
      { dataDir },
    );
    expect(ping.exitCode).toBe(0);

    // Backdate the role's status change (stale) and the recruiter contact
    // (overdue) past settings.json's defaults (stale_days=14,
    // recruiter_nudge_days=7), and put it in denied status with a
    // past reapply_after (ready to reapply).
    const db = openDb(dbPath);
    db.exec(`UPDATE roles SET status = 'denied', status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 days'), reapply_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days') WHERE id = 1`);
    db.exec(`UPDATE roles SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 days') WHERE id = 2`);
    db.exec(`UPDATE recruiter_contacts SET contacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') WHERE id = 1`);
    db.close();

    const result = runCli(['status'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('denied: 1');
    expect(result.stdout).toContain('new: 1');
    // Role #1 is denied (terminal) so it must NOT show up under "stale"
    // (nothing is expected to move on it anymore) — only role #2, whose
    // active 'new' status has gone unchanged for 20 days, should.
    expect(result.stdout).toContain('Stale roles (no status change in 14+ days): 1');
    expect(result.stdout).toMatch(/#2.*new since/);
    expect(result.stdout).toContain('Recruiter contacts overdue for follow-up (7+ days, no response): 1');
    expect(result.stdout).toContain('Jane Recruiter');
    expect(result.stdout).toContain('Ready to reapply: 1');
    expect(result.stdout).toMatch(/#1.*reapply_after/);
  });
});
