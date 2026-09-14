import type Database from 'better-sqlite3';
import type { Settings } from '../config/settings.js';
import { listRecruiterContacts, type RecruiterContact } from '../db/repositories/recruiter-contacts.js';
import type { Role } from '../db/repositories/roles.js';
import { ACTIVE_ROLE_STATUSES, ROLE_STATUSES, type RoleStatus } from '../domain/role-status.js';
import { spendSince, type ModelSpend } from '../db/repositories/model-calls.js';
import { buildSurfaceUsage, type SurfaceUsageReport } from './surface-usage.js';

export interface StaleRole {
  id: number;
  title: string | null;
  url: string;
  status: RoleStatus;
  statusChangedAt: string;
}

export interface ReapplyRole {
  id: number;
  title: string | null;
  url: string;
  reapplyAfter: string;
}

export interface PipelineDigest {
  statusCounts: Record<RoleStatus, number>;
  /** Active-status roles whose status hasn't changed in `settings.stale_days` — nothing has moved on them. */
  staleRoles: StaleRole[];
  /** Recruiter contacts with no response after `settings.recruiter_nudge_days` — due for a follow-up. */
  overdueRecruiterContacts: RecruiterContact[];
  /** reapply_after has passed — the cooldown from a prior `denied` is over. */
  reapplyReady: ReapplyRole[];
  /** reapply_after is set but still in the future. */
  reapplyUpcoming: ReapplyRole[];
  /** What the model has actually cost, from the append-only call ledger. */
  modelSpend: { last7Days: ModelSpend; last30Days: ModelSpend };
  /** The slowest recorded actions — where the waiting actually goes. */
  slowestActions: SlowAction[];
  /** How each surface was actually used, and what it cost — the CLI-vs-agent comparison, from real use. */
  surfaceUsage: SurfaceUsageReport;
}

export interface SlowAction {
  component: string;
  action: string;
  durationMs: number;
  occurredAt: string;
}

/**
 * The slowest actions in the window.
 *
 * Deliberately raw rather than averaged: with a personal-scale volume of
 * commands, the single 4-minute call is the thing worth seeing, and a mean
 * would bury it under a hundred 30ms reads.
 */
function slowestActionsSince(db: Database.Database, sinceIso: string, limit = 5): SlowAction[] {
  return (
    db
      .prepare(
        `SELECT component, action, duration_ms, occurred_at FROM operational_logs
         WHERE duration_ms IS NOT NULL AND occurred_at >= ?
         ORDER BY duration_ms DESC LIMIT ?`,
      )
      .all(sinceIso, limit) as { component: string; action: string; duration_ms: number; occurred_at: string }[]
  ).map((row) => ({
    component: row.component,
    action: row.action,
    durationMs: row.duration_ms,
    occurredAt: row.occurred_at,
  }));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function toStaleRole(row: Pick<Role, 'id' | 'title' | 'url' | 'status' | 'status_changed_at'>): StaleRole {
  return { id: row.id, title: row.title, url: row.url, status: row.status, statusChangedAt: row.status_changed_at };
}

function toReapplyRole(row: Pick<Role, 'id' | 'title' | 'url' | 'reapply_after'>): ReapplyRole {
  return { id: row.id, title: row.title, url: row.url, reapplyAfter: row.reapply_after! };
}

/**
 * Computes the whole pipeline digest in one pass — everything `cm status`
 * shows. Kept as a pure-ish query function (no formatting/printing) so it's
 * directly unit-testable against a seeded temp DB, same split as
 * priority.ts and preference-match.ts.
 */
export function buildPipelineDigest(db: Database.Database, settings: Settings): PipelineDigest {
  const statusCounts = Object.fromEntries(ROLE_STATUSES.map((status) => [status, 0])) as Record<RoleStatus, number>;
  const counted = db.prepare('SELECT status, COUNT(*) as count FROM roles GROUP BY status').all() as {
    status: RoleStatus;
    count: number;
  }[];
  for (const row of counted) statusCounts[row.status] = row.count;

  const staleRoles = (
    db
      .prepare(
        `SELECT id, title, url, status, status_changed_at FROM roles
         WHERE status IN (${ACTIVE_ROLE_STATUSES.map(() => '?').join(', ')})
           AND status_changed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         ORDER BY status_changed_at ASC`,
      )
      .all(...ACTIVE_ROLE_STATUSES, `-${settings.stale_days} days`) as Pick<
      Role,
      'id' | 'title' | 'url' | 'status' | 'status_changed_at'
    >[]
  ).map(toStaleRole);

  const overdueRecruiterContacts = listRecruiterContacts(db, { overdueDays: settings.recruiter_nudge_days });

  const reapplyReady = (
    db
      .prepare(
        `SELECT id, title, url, reapply_after FROM roles
         WHERE reapply_after IS NOT NULL AND reapply_after <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY reapply_after ASC`,
      )
      .all() as Pick<Role, 'id' | 'title' | 'url' | 'reapply_after'>[]
  ).map(toReapplyRole);

  const reapplyUpcoming = (
    db
      .prepare(
        `SELECT id, title, url, reapply_after FROM roles
         WHERE reapply_after IS NOT NULL AND reapply_after > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY reapply_after ASC`,
      )
      .all() as Pick<Role, 'id' | 'title' | 'url' | 'reapply_after'>[]
  ).map(toReapplyRole);

  const since7d = isoDaysAgo(7);

  return {
    statusCounts,
    staleRoles,
    overdueRecruiterContacts,
    reapplyReady,
    reapplyUpcoming,
    modelSpend: {
      last7Days: spendSince(db, since7d),
      last30Days: spendSince(db, isoDaysAgo(30)),
    },
    slowestActions: slowestActionsSince(db, since7d),
    // The same cutoff for both, computed once: `cm status` prints the
    // per-surface spend directly above the 7-day total, and two
    // `isoDaysAgo(7)` calls milliseconds apart can put a `model_calls` row
    // inside one window and outside the other — making the two lines
    // disagree by a few cents with nothing to explain it.
    surfaceUsage: buildSurfaceUsage(db, since7d),
  };
}
