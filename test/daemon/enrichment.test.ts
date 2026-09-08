import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { createCompany, findCompanyByUrl, getCompanyById } from '../../src/db/repositories/companies.js';
import { getRoleById } from '../../src/db/repositories/roles.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { runCli } from '../helpers/run-cli.js';

// Generous: a claude -p call is normally ~2-4s, but observed latency varies
// a lot in practice (one manual run during development took 15-18s for a
// single call with no error, no retry — just slow) and failJob's
// retry/backoff (up to 3 attempts) means a transient rate limit adds more
// on top of that. A tighter window makes ordinary live-dependency variance
// indistinguishable from an actual bug.
const TEST_TIMEOUT_MS = 90_000;

let dataDir: string;
let dbPath: string;
let server: FixtureServer;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-enrichment-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(async () => {
  const pidPath = path.join(dataDir, 'daemon.pid');
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone.
      }
    }
  } catch {
    // no pid file.
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
  await server?.close();
});

async function pollUntil<T>(
  read: () => T | undefined,
  predicate: (value: T) => boolean,
  timeoutMs = 80_000,
  intervalMs = 300,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && predicate(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition. Last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('structural-fetch enrichment (live claude -p, local fixture server)', () => {
  it(
    'cm companies add fetches and fills in name/description in the background',
    async () => {
      server = await startFixtureServer({
        '/acme': `<html><body><h1>Acme Corp</h1><p>Acme Corp builds rockets for interplanetary logistics.</p></body></html>`,
      });

      const add = runCli(['companies', 'add', `${server.url}/acme`], {
        dataDir,
        allowDaemonAutostart: true,
      });
      expect(add.exitCode).toBe(0);

      const company = await pollUntil(
        () => {
          const db = openDb(dbPath);
          const row = getCompanyById(db, 1);
          db.close();
          return row;
        },
        (row) => row?.name != null,
      );

      expect(company.name).toMatch(/Acme/i);
      expect(company.description).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cm roles add without --company resolves and creates the company from the role page, then enriches it too',
    async () => {
      // Routes is read by reference on every request, so it can be filled
      // in after the server starts, once its own URL (needed inside the
      // role page's content) is known.
      const routes: Record<string, string> = {};
      server = await startFixtureServer(routes);
      routes['/globex'] =
        `<html><body><h1>Globex Corporation</h1><p>Globex Corporation builds satellite logistics platforms.</p></body></html>`;
      routes['/jobs/1'] = `<html><body>
        <h1>Senior Backend Engineer</h1>
        <p>Join Globex Corporation to build distributed systems for satellite logistics.</p>
        <p>Company homepage: ${server.url}/globex</p>
      </body></html>`;

      const add = runCli(['roles', 'add', `${server.url}/jobs/1`], {
        dataDir,
        allowDaemonAutostart: true,
      });
      expect(add.exitCode).toBe(0);

      const role = await pollUntil(
        () => {
          const db = openDb(dbPath);
          const row = getRoleById(db, 1);
          db.close();
          return row;
        },
        (row) => row?.company_id != null,
      );

      expect(role.title).toMatch(/Engineer/i);
      expect(role.company_id).not.toBeNull();

      const company = await pollUntil(
        () => {
          const db = openDb(dbPath);
          const row = getCompanyById(db, role.company_id!);
          db.close();
          return row;
        },
        (row) => row?.description != null,
      );

      expect(company.name).toMatch(/Globex/i);
      expect(company.description).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'attaches to an already-tracked company instead of creating a duplicate',
    async () => {
      const routes: Record<string, string> = {};
      server = await startFixtureServer(routes);
      const companyUrl = `${server.url}/initech`;
      routes['/initech'] = `<html><body><h1>Initech</h1><p>Initech makes office software.</p></body></html>`;
      routes['/jobs/9'] = `<html><body>
        <h1>Office Software Engineer</h1>
        <p>Initech is hiring an engineer for our TPS reporting platform.</p>
        <p>Company homepage: ${companyUrl}</p>
      </body></html>`;

      // Pre-create the company exactly as the role page will state it, so
      // resolution should find it rather than create a second one.
      const setupDb = openDb(dbPath);
      const existing = createCompany(setupDb, companyUrl, 'Initech');
      setupDb.close();

      const add = runCli(['roles', 'add', `${server.url}/jobs/9`], {
        dataDir,
        allowDaemonAutostart: true,
      });
      expect(add.exitCode).toBe(0);

      const role = await pollUntil(
        () => {
          const db = openDb(dbPath);
          const row = getRoleById(db, 1);
          db.close();
          return row;
        },
        (row) => row?.company_id != null,
      );

      expect(role.company_id).toBe(existing.id);

      const readDb = openDb(dbPath);
      const match = findCompanyByUrl(readDb, companyUrl);
      const allCompaniesCount = readDb.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number };
      readDb.close();

      expect(match?.id).toBe(existing.id);
      expect(allCompaniesCount.c).toBe(1); // no duplicate created
    },
    TEST_TIMEOUT_MS,
  );
});
