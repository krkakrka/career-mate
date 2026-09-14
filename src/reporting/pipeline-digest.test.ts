import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '../config/settings.js';
import { openDb } from '../db/client.js';
import { createCompany } from '../db/repositories/companies.js';
import { createRecruiterContact } from '../db/repositories/recruiter-contacts.js';
import { createRole, setReapplyAfter, setStatus } from '../db/repositories/roles.js';
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
};

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-digest-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
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

  it('splits roles with a reapply_after into ready (past) vs upcoming (future)', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const ready = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/ready' });
    setReapplyAfter(db, ready.id, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const upcoming = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/upcoming' });
    setReapplyAfter(db, upcoming.id, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/none' }); // no reapply_after at all

    const digest = buildPipelineDigest(db, SETTINGS);

    expect(digest.reapplyReady.map((r) => r.id)).toEqual([ready.id]);
    expect(digest.reapplyUpcoming.map((r) => r.id)).toEqual([upcoming.id]);
  });
});
