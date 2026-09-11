import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { createCompany } from '../../src/db/repositories/companies.js';
import { createRole, updateStructuralFields } from '../../src/db/repositories/roles.js';
import { killDaemon } from '../helpers/kill-daemon.js';
import { runCli } from '../helpers/run-cli.js';

// Two sequential `cm tips` invocations: the first does company research +
// role research (2 live claude -p web-search calls), the second reuses the
// cached company tips and does only role research (1 more call). Tips
// research is much deeper than step 8's structured-field lookups — it
// produces full cited markdown reports across many sources, not 2-3
// numbers — and a manual timed run of just the *first* call alone took
// 109s. Budgeted with real headroom instead of guessing again.
// Four live `claude -p` web-search calls (company + role tips, twice
// over), which have been observed taking 390-465s in total — this budget
// was set just under the observed range and the test failed on roughly
// two runs in three for want of ~60s, not for any assertion. Step 21 moves
// live tests out of `npm test` entirely; until then, the budget should at
// least reflect what the work actually costs.
const TEST_TIMEOUT_MS = 900_000;

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-tips-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(async () => {
  await killDaemon(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm tips (live claude -p web search)', () => {
  it(
    'produces cited tips, and a second role at the same company reuses cached company-level findings instead of re-researching',
    async () => {
      const db = openDb(dbPath);
      const company = createCompany(db, 'https://stripe.com', 'Stripe');
      const roleA = createRole(db, { companyId: company.id, url: 'https://stripe.com/jobs/a' });
      updateStructuralFields(db, roleA.id, {
        title: 'Software Engineer, Payments Infrastructure',
        description: 'Work on core payments infrastructure at Stripe.',
      });
      const roleB = createRole(db, { companyId: company.id, url: 'https://stripe.com/jobs/b' });
      updateStructuralFields(db, roleB.id, {
        title: 'Software Engineer, Developer Platform',
        description: 'Work on developer-facing APIs and tooling at Stripe.',
      });
      db.close();

      const firstRun = runCli(['tips', String(roleA.id)], { dataDir, allowDaemonAutostart: true });
      expect(firstRun.exitCode).toBe(0);
      expect(firstRun.stdout).toContain('## Company tips');
      expect(firstRun.stdout).toContain('## Role-specific tips');
      expect(firstRun.stdout).toContain('Sources:');

      const afterFirst = openDb(dbPath);
      const companyTipsCount = afterFirst
        .prepare("SELECT COUNT(*) as c FROM tips WHERE scope = 'company' AND company_id = ?")
        .get(company.id) as { c: number };
      const roleATipsCount = afterFirst
        .prepare("SELECT COUNT(*) as c FROM tips WHERE scope = 'role' AND role_id = ?")
        .get(roleA.id) as { c: number };
      const companyTipsRow = afterFirst
        .prepare("SELECT sources FROM tips WHERE scope = 'company' AND company_id = ?")
        .get(company.id) as { sources: string };
      afterFirst.close();
      expect(companyTipsCount.c).toBe(1);
      expect(roleATipsCount.c).toBe(1);

      // The plan's actual test criterion: a non-empty sources array, not
      // just the word "Sources:" appearing in the output (which also
      // prints for the empty/uncited case).
      const companySources = JSON.parse(companyTipsRow.sources) as { url: string; title: string }[];
      expect(companySources.length).toBeGreaterThan(0);
      expect(companySources[0]).toHaveProperty('url');

      const secondRun = runCli(['tips', String(roleB.id)], { dataDir, allowDaemonAutostart: true });
      expect(secondRun.exitCode).toBe(0);
      expect(secondRun.stdout).toContain('## Company tips');
      expect(secondRun.stdout).toContain('## Role-specific tips');

      const afterSecond = openDb(dbPath);
      const companyTipsCountAfter = afterSecond
        .prepare("SELECT COUNT(*) as c FROM tips WHERE scope = 'company' AND company_id = ?")
        .get(company.id) as { c: number };
      const roleBTipsCount = afterSecond
        .prepare("SELECT COUNT(*) as c FROM tips WHERE scope = 'role' AND role_id = ?")
        .get(roleB.id) as { c: number };
      afterSecond.close();

      // Still exactly 1 — the second run reused the cached company tips
      // rather than researching them again.
      expect(companyTipsCountAfter.c).toBe(1);
      expect(roleBTipsCount.c).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
