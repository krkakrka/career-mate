import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { enqueueJob, getJobById } from '../../src/db/repositories/jobs.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;
let dbPath: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-logs-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('cm logs', () => {
  it('shows durable records for CLI actions', () => {
    expect(runCli(['companies', 'list'], { dataDir }).exitCode).toBe(0);
    const logs = runCli(['logs', '--component', 'cli'], { dataDir });
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout).toContain('cli.companies list');
    expect(logs.stdout).toContain('/succeeded');
  });

  it(
    '--entity role <id> shows a failed job\'s actionable error and correlation, and `cm worker failed` shows the same job',
    async () => {
      // role-structural against a nonexistent role fails deterministically,
      // before any network/claude call — no live dependency needed here.
      const db = openDb(dbPath);
      const job = enqueueJob(db, { topic: 'enrichment', payload: { kind: 'role-structural', roleId: 999 } });
      db.close();

      // Default retry policy is 3 attempts with exponential backoff — drain
      // repeatedly (each attempt fails instantly; only the wait between
      // attempts takes real time) until the job lands in its terminal
      // `failed` state, rather than assuming a single drain reaches it.
      const deadline = Date.now() + 15_000;
      for (;;) {
        runCli(['worker', 'drain'], { dataDir });
        const readDb = openDb(dbPath);
        const current = getJobById(readDb, job.id);
        readDb.close();
        if (current?.status === 'failed') break;
        if (Date.now() > deadline) throw new Error(`Job never reached 'failed': ${JSON.stringify(current)}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const logs = runCli(['logs', '--entity', 'role', '--id', '999'], { dataDir });
      expect(logs.exitCode).toBe(0);
      expect(logs.stdout).toMatch(/role=#999/);
      expect(logs.stdout).toContain('error: ');
      expect(logs.stdout).toMatch(/Role #999 not found/);

      const failed = runCli(['worker', 'failed'], { dataDir });
      expect(failed.exitCode).toBe(0);
      expect(failed.stdout).toMatch(/Role #999 not found/);
    },
    20_000,
  );
});
