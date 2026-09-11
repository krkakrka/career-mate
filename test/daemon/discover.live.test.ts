import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { createCompany } from '../../src/db/repositories/companies.js';
import { listRoles, type Role } from '../../src/db/repositories/roles.js';
import { killDaemon } from '../helpers/kill-daemon.js';
import { runCli } from '../helpers/run-cli.js';

// discover has no fixture-server control point at all (unlike structural
// fetch/refresh, which fetch a page first) — its only I/O is an open
// claude -p web search per company, same category of live dependency as
// step 10's tips research. Budgeted the same generous window as tips.ts
// (a single tips web-search call was observed taking 109s).
const TEST_TIMEOUT_MS = 400_000;

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-discover-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(async () => {
  await killDaemon(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** `cm discover` is fire-and-forget — poll DB state directly, same as refresh.test.ts / enrichment.test.ts. */
async function pollUntil<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 380_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition. Last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readRoles(dbPath: string, companyId: number): Role[] {
  const db = openDb(dbPath);
  const roles = listRoles(db, { companyId });
  db.close();
  return roles;
}

describe('cm discover (live claude -p web search)', () => {
  it(
    'finds real open roles at a large, always-hiring company, and a second run finds no new ones (duplicate-checked)',
    async () => {
      const db = openDb(dbPath);
      // Stripe reliably has many public job postings at any given time —
      // the same real-world assumption step 8's enrichment test leans on
      // for ipo_status ("reliably, publicly private for years").
      const company = createCompany(db, 'https://stripe.com', 'Stripe');
      db.close();

      const firstRun = runCli(['discover'], { dataDir, allowDaemonAutostart: true });
      expect(firstRun.exitCode).toBe(0);
      expect(firstRun.stdout).toMatch(/Scanning 1 tracked company/);

      const roles = await pollUntil(() => readRoles(dbPath, company.id), (rows) => rows.length > 0);
      for (const role of roles) {
        expect(role.url).toMatch(/^https?:\/\//);
      }

      const secondRun = runCli(['discover'], { dataDir, allowDaemonAutostart: true });
      expect(secondRun.exitCode).toBe(0);

      // Give the second discover pass time to run, then confirm no
      // duplicates were created for postings already tracked from the
      // first run (a fixed wait, not a poll-for-change, since "nothing new
      // happened" has no positive signal to poll for).
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      const rolesAfterSecond = readRoles(dbPath, company.id);
      expect(rolesAfterSecond.length).toBe(roles.length);
    },
    TEST_TIMEOUT_MS,
  );

  it('reports nothing to scan when there are no tracked companies', () => {
    const result = runCli(['discover'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No tracked companies to scan.');
  });
});
