import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '../config/settings.js';
import { openDb } from '../db/client.js';
import { createCompany } from '../db/repositories/companies.js';
import { createRecruiterContact } from '../db/repositories/recruiter-contacts.js';
import { createRole, markClosed, setReapplyAfter, setStatus } from '../db/repositories/roles.js';
import { buildFunnel } from './funnel.js';

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
};

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-funnel-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function backdateStatus(roleId: number, days: number): void {
  db.prepare('UPDATE roles SET status_changed_at = ? WHERE id = ?').run(daysAgoIso(days), roleId);
}

describe('the board', () => {
  it('lists every stage, including the empty ones', () => {
    const funnel = buildFunnel(db, SETTINGS);

    // An empty `interviewing` is information; a board with holes is harder
    // to read than one with zeroes.
    expect(funnel.stages.map((stage) => stage.status)).toEqual([
      'new', 'todo', 'applied', 'interviewing', 'success', 'denied', 'skip',
    ]);
    expect(funnel.totalActive).toBe(0);
  });

  it('groups opportunities by stage and separates terminal ones', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/1' });
    const applied = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/2' });
    const denied = createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/3' });
    setStatus(db, applied.id, 'applied', 'sent');
    setStatus(db, denied.id, 'denied', 'no');

    const funnel = buildFunnel(db, SETTINGS);
    const stage = (status: string) => funnel.stages.find((s) => s.status === status)!;

    expect(stage('new').opportunities).toHaveLength(1);
    expect(stage('applied').opportunities).toHaveLength(1);
    expect(stage('denied').opportunities).toHaveLength(1);
    expect(stage('denied').terminal).toBe(true);
    expect(stage('applied').terminal).toBe(false);
    // Terminal roles do not count as active work.
    expect(funnel.totalActive).toBe(2);
    expect(stage('new').opportunities[0]!.company).toBe('Acme');
  });
});

describe('what needs attention', () => {
  it('flags a posting that closed while the role still looks live', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    setStatus(db, role.id, 'applied', 'sent');
    markClosed(db, role.id);

    const [item] = buildFunnel(db, SETTINGS).needsAttention;

    // Wrong data beats a nudge: you are still thinking about a dead role.
    expect(item).toMatchObject({ roleId: role.id, reason: 'closed-not-triaged' });
    expect(item!.detail).toMatch(/still sits in "applied"/);
  });

  it('flags a recruiter who never replied', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    const contact = createRecruiterContact(db, { roleId: role.id, recruiterName: 'Dana', channel: 'email' });
    db.prepare('UPDATE recruiter_contacts SET contacted_at = ? WHERE id = ?').run(daysAgoIso(20), contact.id);

    const item = buildFunnel(db, SETTINGS).needsAttention.find((i) => i.reason === 'recruiter-overdue');

    expect(item?.detail).toMatch(/Dana contacted 20 days ago, no reply/);
  });

  it('flags a reapply cooldown that has elapsed', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    setStatus(db, role.id, 'denied', 'no');
    setReapplyAfter(db, role.id, daysAgoIso(3));

    const item = buildFunnel(db, SETTINGS).needsAttention.find((i) => i.reason === 'reapply-ready');

    expect(item?.roleId).toBe(role.id);
  });

  it('flags a role nothing has moved on', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    backdateStatus(role.id, 30);

    const [item] = buildFunnel(db, SETTINGS).needsAttention;

    expect(item).toMatchObject({ reason: 'stale' });
    expect(item!.detail).toMatch(/nothing has moved in 30 days/);
  });

  it('does not also nag about staleness when something sharper is already wrong', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    setStatus(db, role.id, 'applied', 'sent');
    markClosed(db, role.id);
    backdateStatus(role.id, 40);

    const items = buildFunnel(db, SETTINGS).needsAttention.filter((i) => i.roleId === role.id);

    // One role, one reason — the most actionable one.
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toBe('closed-not-triaged');
  });

  it('orders by how much it costs to ignore', () => {
    const stale = createRole(db, { url: 'https://acme.example.com/jobs/stale' });
    backdateStatus(stale.id, 30);

    const closed = createRole(db, { url: 'https://acme.example.com/jobs/closed' });
    setStatus(db, closed.id, 'applied', 'sent');
    markClosed(db, closed.id);

    const reapply = createRole(db, { url: 'https://acme.example.com/jobs/reapply' });
    setStatus(db, reapply.id, 'denied', 'no');
    setReapplyAfter(db, reapply.id, daysAgoIso(2));

    expect(buildFunnel(db, SETTINGS).needsAttention.map((i) => i.reason)).toEqual([
      'closed-not-triaged',
      'reapply-ready',
      'stale',
    ]);
  });

  it('is empty when there is genuinely nothing to do', () => {
    createRole(db, { url: 'https://acme.example.com/jobs/1' });
    expect(buildFunnel(db, SETTINGS).needsAttention).toEqual([]);
  });
});

describe('stage boundaries', () => {
  it('stops chasing a recruiter once the role is closed out', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    const contact = createRecruiterContact(db, { roleId: role.id, recruiterName: 'Dana', channel: 'email' });
    db.prepare('UPDATE recruiter_contacts SET contacted_at = ? WHERE id = ?').run(daysAgoIso(20), contact.id);
    expect(buildFunnel(db, SETTINGS).needsAttention).toHaveLength(1);

    setStatus(db, role.id, 'skip', 'not for me');

    // listRecruiterContacts filters on an unanswered contact, never on the
    // role's stage — so once the board began including terminal roles this
    // nagged about follow-ups for roles already skipped, forever.
    expect(buildFunnel(db, SETTINGS).needsAttention).toEqual([]);
  });

  it('reports one item per role, however many reasons apply', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    setStatus(db, role.id, 'applied', 'sent');
    markClosed(db, role.id);
    for (const name of ['Dana', 'Sam', 'Alex']) {
      const contact = createRecruiterContact(db, { roleId: role.id, recruiterName: name, channel: 'email' });
      db.prepare('UPDATE recruiter_contacts SET contacted_at = ? WHERE id = ?').run(daysAgoIso(20), contact.id);
    }

    const items = buildFunnel(db, SETTINGS).needsAttention;

    // `cm` shows only the top few, so one noisy role must not push every
    // other role's alert off the board.
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toBe('closed-not-triaged');
  });

  it('does not say "today ago"', () => {
    const role = createRole(db, { url: 'https://acme.example.com/jobs/1' });
    setStatus(db, role.id, 'applied', 'sent');
    markClosed(db, role.id);

    const detail = buildFunnel(db, SETTINGS).needsAttention[0]!.detail;

    expect(detail).toContain('less than a day ago');
    expect(detail).not.toContain('today ago');
  });
});
