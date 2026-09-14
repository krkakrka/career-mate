import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-prune-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Seeds one old completed job with spend against it, plus one old log row. */
function seedOldRecords(): void {
  const db = openDb(dbPath);
  const job = db
    .prepare("INSERT INTO jobs (topic, payload, status, origin, updated_at) VALUES ('enrichment', '{}', 'done', 'mcp', ?)")
    .run(daysAgo(200)).lastInsertRowid as number;
  // The call is dated *now* while its job is dated 200 days ago. Decoupled
  // deliberately: the job has to be old enough to prune, and the spend has
  // to be inside `cm status`'s 7-day window for the assertion about
  // attribution surviving to mean anything.
  db.prepare(
    "INSERT INTO model_calls (kind, model, cost_usd, job_id, origin) VALUES ('role_research', 'sonnet', 0.42, ?, 'mcp')",
  ).run(job);
  db.prepare(
    "INSERT INTO operational_logs (severity, outcome, component, action, occurred_at) VALUES ('info', 'succeeded', 'cli', 'x', ?)",
  ).run(daysAgo(200));
  db.close();
}

function counts(): { jobs: number; logs: number; spend: number } {
  const db = openDb(dbPath);
  const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const result = { jobs: n('jobs'), logs: n('operational_logs'), spend: n('model_calls') };
  db.close();
  return result;
}

describe('cm prune', () => {
  it('reports what it would delete without touching anything', () => {
    seedOldRecords();
    const before = counts();

    const result = runCli(['prune', '--dry-run'], { dataDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Would delete');
    expect(result.stdout).toContain('completed jobs:   1');
    // Jobs and spend untouched. Log rows are not compared: running the
    // command writes its own, which is the instrumentation working.
    expect(counts().jobs).toBe(before.jobs);
    expect(counts().spend).toBe(before.spend);
  });

  it('deletes old diagnostics but never the spend ledger', () => {
    // The obvious worry about a command like this is what it took with it,
    // so it says so on every run rather than making you read the source.
    seedOldRecords();

    const result = runCli(['prune'], { dataDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted');
    expect(result.stdout).toContain('Kept: model spend, derivations, page snapshots, events, and any job not yet done.');
    // Named precisely rather than promised broadly: removing a job does
    // clear `job_id` on the rows that referenced it.
    expect(result.stdout).toContain('clears the job link on related logs, derivations and spend rows');
    expect(counts().jobs).toBe(0);
    expect(counts().spend).toBe(1);
  });

  it('leaves the pruned job\'s spend attributed to the surface that caused it', () => {
    // Migration 0011's whole purpose: the FK is ON DELETE SET NULL, so
    // before it, pruning silently moved historical spend into
    // "unattributed" and rewrote the CLI-vs-agent answer.
    seedOldRecords();
    runCli(['prune'], { dataDir });

    const status = runCli(['status'], { dataDir });
    const line = status.stdout.split('\n').find((l) => l.trim().startsWith('mcp'))!;
    expect(line).toContain('$0.42 over 1 model call(s)');
    expect(status.stdout).not.toContain('unattributed');
  });

  it('honours an explicit retention window', () => {
    seedOldRecords();

    // Far longer than the seeded rows are old, so nothing qualifies.
    const result = runCli(['prune', '--older-than', '365'], { dataDir });

    expect(result.stdout).toContain('completed jobs:   0');
    expect(counts().jobs).toBe(1);
  });

  it('reads the retention window from settings', () => {
    // Otherwise replacing `loadSettings().prune_after_days` with a literal
    // 90 passes the whole suite — which is what left the clamp bug below
    // undetected.
    seedOldRecords();
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), JSON.stringify({ prune_after_days: 365 }));

    const result = runCli(['prune', '--dry-run'], { dataDir });

    expect(result.stdout).toContain('older than 365 day(s)');
    expect(result.stdout).toContain('completed jobs:   0');
  });

  it('falls back to the default rather than deleting everything for a nonsensical setting', () => {
    // Clamping `-1` to `0` produced a cutoff of *now*, so `cm prune` deleted
    // every log row including ones written seconds earlier. `0` is the same
    // trap from the other side: elsewhere in settings.json `0` means
    // "disabled", so someone switching pruning off would have got total
    // deletion.
    seedOldRecords();
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });

    for (const prune_after_days of [-1, 0]) {
      fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), JSON.stringify({ prune_after_days }));
      const result = runCli(['prune', '--dry-run'], { dataDir });
      expect(result.stdout, String(prune_after_days)).toContain('older than 90 day(s)');
    }
  });

  it('says the file will not shrink on its own, and shrinks it when asked', () => {
    seedOldRecords();

    const plain = runCli(['prune'], { dataDir });
    expect(plain.stdout).toContain('--vacuum');

    seedOldRecords();
    const vacuumed = runCli(['prune', '--vacuum'], { dataDir });
    expect(vacuumed.exitCode).toBe(0);
    expect(vacuumed.stdout).not.toContain('rerun with --vacuum');
  });

  it('rejects a negative retention rather than deleting everything', () => {
    const result = runCli(['prune', '--older-than', '-5'], { dataDir });
    expect(result.exitCode).not.toBe(0);
  });
});
