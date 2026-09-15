import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '../config/settings.js';
import { restoreEnv } from '../../test/helpers/env.js';
import { openDb } from '../db/client.js';
import { createCompany } from '../db/repositories/companies.js';
import { createRecruiterContact } from '../db/repositories/recruiter-contacts.js';
import { createRole, getRoleById, setReapplyAfter, setStatus } from '../db/repositories/roles.js';
import { buildPipelineDigest } from './pipeline-digest.js';

const SETTINGS: Settings = {
  recruiter_nudge_days: 7,
  stale_days: 14,
  reapply_cooldown_months: 1,
  page_refresh_days: { role: 3, company: 30 },
  claude_max_budget_usd: 0.5,
  claude_timeout_seconds: 180,
  recompute_min_interval_minutes: 60,
  stale_running_job_minutes: 30,
  daemon_idle_exit_minutes: 30,
  browser_trace: 'on-failure',
  browser_trace_keep: 20,
  prune_after_days: 90,
  discover_max_new_roles_per_run: 25,
  notification_channel: 'terminal' as const,
};

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-digest-'));
  // Required even though this suite opens its database explicitly:
  // `setStatus` reads `settings.json` through `getDataDir()`, and
  // `loadJsonConfig` *creates* the file when missing — so without this the
  // suite writes into the developer's real `.data` and silently inherits
  // their personal cooldown setting.
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function backdateRoleStatusChange(roleId: number, days: number): void {
  db.prepare(`UPDATE roles SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?`).run(
    `-${days} days`,
    roleId,
  );
}

describe('buildPipelineDigest', () => {
  it('counts every role status, including statuses with zero roles', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/1' });

    const digest = buildPipelineDigest(db, SETTINGS);

    expect(digest.statusCounts).toEqual({
      new: 1,
      todo: 0,
      applied: 0,
      interviewing: 0,
      success: 0,
      denied: 0,
      skip: 0,
    });
  });

  it('flags an active role as stale once its status hasn\'t changed in stale_days, but not a fresher one', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const staleRole = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/stale' });
    backdateRoleStatusChange(staleRole.id, 20);
    const freshRole = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/fresh' });
    backdateRoleStatusChange(freshRole.id, 2);

    const digest = buildPipelineDigest(db, SETTINGS);

    expect(digest.staleRoles.map((r) => r.id)).toEqual([staleRole.id]);
  });

  it('does not flag a terminal-status role as stale even if old, since nothing is expected to move on it', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const role = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/1' });
    setStatus(db, role.id, 'denied');
    backdateRoleStatusChange(role.id, 30);

    const digest = buildPipelineDigest(db, SETTINGS);

    expect(digest.staleRoles).toHaveLength(0);
  });

  it('surfaces a recruiter contact overdue by recruiter_nudge_days, and not one recently contacted', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const role = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/1' });
    const overdue = createRecruiterContact(db, { roleId: role.id, recruiterName: 'Overdue Recruiter' });
    db.prepare(`UPDATE recruiter_contacts SET contacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') WHERE id = ?`).run(
      overdue.id,
    );
    createRecruiterContact(db, { roleId: role.id, recruiterName: 'Recent Recruiter' });

    const digest = buildPipelineDigest(db, SETTINGS);

    expect(digest.overdueRecruiterContacts.map((c) => c.recruiter_name)).toEqual(['Overdue Recruiter']);
  });

  it('splits denied roles with a reapply_after into ready (past) vs upcoming (future)', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const ready = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/ready' });
    setStatus(db, ready.id, 'denied');
    setReapplyAfter(db, ready.id, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const upcoming = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/upcoming' });
    setStatus(db, upcoming.id, 'denied');
    setReapplyAfter(db, upcoming.id, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/none' }); // no reapply_after at all

    const digest = buildPipelineDigest(db, SETTINGS);

    expect(digest.reapplyReady.map((r) => r.id)).toEqual([ready.id]);
    expect(digest.reapplyUpcoming.map((r) => r.id)).toEqual([upcoming.id]);
  });

  it('stops offering to reapply once the role has moved on from denied', () => {
    // `reapply_after` survives a move out of `denied` — a reopened req you
    // set back to `applied` keeps its date — so without a status filter the
    // digest goes on suggesting you reapply for a role you are actively in
    // process on. `funnel.ts` has always filtered this way; the digest did
    // not, and pinning the surviving-date behaviour is what exposed it.
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const reopened = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/reopened' });
    setStatus(db, reopened.id, 'denied');
    setReapplyAfter(db, reopened.id, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    setStatus(db, reopened.id, 'applied');

    const digest = buildPipelineDigest(db, SETTINGS);
    expect(digest.reapplyReady).toEqual([]);
    expect(digest.reapplyUpcoming).toEqual([]);
    // The date itself is kept, so moving back to `denied` restores it.
    expect(getRoleById(db, reopened.id)!.reapply_after).not.toBeNull();
  });
});
