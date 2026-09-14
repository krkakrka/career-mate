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

describe('cm status — usage by surface', () => {
  it('names both surfaces even before either has been used', () => {
    // A surface missing from the list reads as "never used" and as "not
    // installed" identically, and the block exists to compare the two.
    const result = runCli(['status'], { dataDir });

    expect(result.stdout).toContain('Usage by surface (7d):');
    expect(result.stdout).toMatch(/cli\s+not used yet/);
    expect(result.stdout).toMatch(/mcp\s+not used yet/);
  });

  it('counts a real CLI invocation and reports its timing', () => {
    // Driven through the actual binary rather than by inserting log rows:
    // the measurement is only worth anything if the instrumentation it
    // depends on is really wired to the commands people run.
    runCli(['companies', 'list'], { dataDir });
    runCli(['companies', 'list'], { dataDir });

    const result = runCli(['status'], { dataDir });
    const line = result.stdout.split('\n').find((l) => l.trim().startsWith('cli'))!;

    expect(line).toMatch(/cli\s+\d+ call\(s\)/);
    expect(line).toContain('median');
    expect(line).toContain('p90');
    expect(line).toContain('model call(s)');
    // The finding this block exists to surface: a CLI command does a few ms
    // of work and costs a third of a second, because every invocation pays
    // Node and the tsx loader afresh. Omitting it made the CLI look ~65x
    // cheaper than it is.
    expect(line).toMatch(/\+\S+ startup\/call/);
  });

  it('attributes daemon spend to the surface that caused the job', () => {
    // Neither surface spends anything directly — the daemon does, on a
    // queue both feed — so without jobs.origin this block could only ever
    // report $0.00 against each surface and the whole comparison would be
    // half-measured.
    const db = openDb(dbPath);
    const job = db
      .prepare("INSERT INTO jobs (topic, payload, origin) VALUES ('enrichment', '{}', 'mcp')")
      .run();
    db.prepare(
      "INSERT INTO model_calls (kind, model, cost_usd, job_id) VALUES ('role_research', 'sonnet', 0.42, ?)",
    ).run(job.lastInsertRowid as number);
    db.close();

    const result = runCli(['status'], { dataDir });
    const line = result.stdout.split('\n').find((l) => l.trim().startsWith('mcp'))!;

    expect(line).toContain('$0.42 over 1 model call(s)');
  });

  it('shows unattributed spend separately rather than hiding it in a surface', () => {
    const db = openDb(dbPath);
    db.prepare("INSERT INTO model_calls (kind, model, cost_usd) VALUES ('role_research', 'sonnet', 0.19)").run();
    db.close();

    const result = runCli(['status'], { dataDir });

    expect(result.stdout).toContain('unattributed: $0.19 over 1 model call(s)');
  });
});
