import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { createCompany } from '../../src/db/repositories/companies.js';
import { listUnacknowledgedNotifications } from '../../src/db/repositories/notifications.js';
import { createRole, getRoleById, type Role } from '../../src/db/repositories/roles.js';
import { killDaemon } from '../helpers/kill-daemon.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { runCli } from '../helpers/run-cli.js';

// A single claude -p content-judgment call, same order of magnitude as
// step 7/8's structural/research calls (observed up to ~18-20s, occasionally
// more) — budgeted with the same generous headroom, not a tighter re-guess.
const TEST_TIMEOUT_MS = 90_000;

let dataDir: string;
let dbPath: string;
let server: FixtureServer | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-refresh-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(async () => {
  await killDaemon(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
  await server?.close();
  server = undefined;
});

/**
 * `cm refresh` is fire-and-forget (like `roles add`/`companies add`) — it
 * enqueues and returns immediately, the daemon does the actual work in the
 * background. So the test polls DB state itself, same as
 * test/daemon/enrichment.test.ts's pollUntil.
 */
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

describe('cm refresh (live claude -p, local fixture server)', () => {
  it(
    'detects a closed posting from page content (HTTP 200, no 404) and produces a notification',
    async () => {
      server = await startFixtureServer({
        '/jobs/closed': `<html><body>
          <h1>Senior Backend Engineer</h1>
          <p>This position is no longer accepting applications. Thank you for your interest — we have filled this role.</p>
        </body></html>`,
      });

      const db = openDb(dbPath);
      const company = createCompany(db, 'https://acme.example.com', 'Acme');
      const role = createRole(db, { companyId: company.id, url: `${server.url}/jobs/closed` });
      db.close();

      const result = runCli(['refresh'], { dataDir, allowDaemonAutostart: true });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Checking 1 role(s) for closure');

      const updated = await pollUntil<Role>(
        () => {
          const readDb = openDb(dbPath);
          const row = getRoleById(readDb, role.id);
          readDb.close();
          return row;
        },
        (row) => row.last_checked_at != null,
      );

      expect(updated.closed_at).not.toBeNull();

      // The role update and the notification are two separate job
      // completions (role-closure-check, then the notification job it
      // enqueues) — poll for the notification landing rather than
      // asserting immediately after the role's own state settles.
      await pollUntil(
        () => {
          const readDb = openDb(dbPath);
          const notifications = listUnacknowledgedNotifications(readDb);
          readDb.close();
          return notifications;
        },
        (rows) => rows.some((n) => n.message.toLowerCase().includes('closed')),
      );

      const inbox = runCli(['inbox'], { dataDir });
      expect(inbox.exitCode).toBe(0);
      expect(inbox.stdout).toMatch(/closed/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves a still-open posting alone',
    async () => {
      server = await startFixtureServer({
        '/jobs/open': `<html><body>
          <h1>Senior Backend Engineer</h1>
          <p>We are actively hiring for this role. Apply now to join our team building distributed systems.</p>
        </body></html>`,
      });

      const db = openDb(dbPath);
      const company = createCompany(db, 'https://acme.example.com', 'Acme');
      const role = createRole(db, { companyId: company.id, url: `${server.url}/jobs/open` });
      db.close();

      const result = runCli(['refresh'], { dataDir, allowDaemonAutostart: true });
      expect(result.exitCode).toBe(0);

      const updated = await pollUntil<Role>(
        () => {
          const readDb = openDb(dbPath);
          const row = getRoleById(readDb, role.id);
          readDb.close();
          return row;
        },
        (row) => row.last_checked_at != null,
      );

      expect(updated.closed_at).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it('reports nothing to check when there are no active roles', () => {
    const result = runCli(['refresh'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active roles to check.');
  });
});
