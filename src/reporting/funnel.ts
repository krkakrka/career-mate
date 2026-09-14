import type Database from 'better-sqlite3';
import type { Settings } from '../config/settings.js';
import { getCompanyById } from '../db/repositories/companies.js';
import { listRecruiterContacts } from '../db/repositories/recruiter-contacts.js';
import { listRoles, type Role } from '../db/repositories/roles.js';
import { ACTIVE_ROLE_STATUSES, ROLE_STATUSES, type RoleStatus } from '../domain/role-status.js';

/**
 * The funnel view: opportunities moving through stages, and the ones that
 * need something from you.
 *
 * This is the shape the tool was always modelling — `roles.status` has been
 * the funnel since Step 4 — but nothing ever showed it that way. The CLI
 * made you think in entities and commands; this makes the unit of thought
 * an opportunity and its stage, which is how the work is actually held in
 * someone's head.
 *
 * Pure query logic, no formatting: `cm`/`cm next` render it, and the MCP
 * server hands the same structure to an agent. One good "what's going on"
 * tool beats a dozen small ones an agent has to compose.
 */

export interface FunnelOpportunity {
  roleId: number;
  title: string | null;
  url: string;
  company: string | null;
  status: RoleStatus;
  statusChangedAt: string;
  closedAt: string | null;
}

export interface FunnelStage {
  status: RoleStatus;
  /** Terminal stages are shown separately: nothing is expected to move on them. */
  terminal: boolean;
  opportunities: FunnelOpportunity[];
}

/**
 * Ordered by how much it costs to ignore, not by severity in the abstract.
 * A posting that closed while you still think it is live is *wrong data*,
 * which beats a nudge; someone waiting on a reply is time-sensitive in a
 * way a stale row is not.
 */
export const ATTENTION_REASONS = ['closed-not-triaged', 'recruiter-overdue', 'reapply-ready', 'stale'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface AttentionItem {
  roleId: number;
  title: string | null;
  company: string | null;
  status: RoleStatus;
  reason: AttentionReason;
  /** Why this is here, in words a person (or an agent relaying to one) can use directly. */
  detail: string;
}

export interface Funnel {
  stages: FunnelStage[];
  needsAttention: AttentionItem[];
  totalActive: number;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A duration, not a date — every caller suffixes it with " ago", so "today" would read as "today ago". */
function describeAge(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(days)) return 'an unknown time';
  if (days <= 0) return 'less than a day';
  return days === 1 ? '1 day' : `${days} days`;
}

export function buildFunnel(db: Database.Database, settings: Settings): Funnel {
  const roles = listRoles(db, { includeTerminal: true });
  const companyNames = new Map<number, string | null>();
  const companyOf = (role: Role): string | null => {
    if (role.company_id == null) return null;
    if (!companyNames.has(role.company_id)) {
      companyNames.set(role.company_id, getCompanyById(db, role.company_id)?.name ?? null);
    }
    return companyNames.get(role.company_id) ?? null;
  };

  const toOpportunity = (role: Role): FunnelOpportunity => ({
    roleId: role.id,
    title: role.title,
    url: role.url,
    company: companyOf(role),
    status: role.status,
    statusChangedAt: role.status_changed_at,
    closedAt: role.closed_at,
  });

  const stages: FunnelStage[] = ROLE_STATUSES.map((status) => ({
    status,
    terminal: !ACTIVE_ROLE_STATUSES.includes(status),
    // Every stage is listed even when empty — an empty `interviewing` is
    // information, and a board with holes in it is harder to read than one
    // with zeroes.
    opportunities: roles.filter((role) => role.status === status).map(toOpportunity),
  }));

  const active = roles.filter((role) => ACTIVE_ROLE_STATUSES.includes(role.status));
  const staleCutoff = daysAgo(settings.stale_days);

  const attention: AttentionItem[] = [];
  /**
   * One role, one reason — the most actionable one.
   *
   * The loops below run in priority order, so the first reason to claim a
   * role wins. Without this guard a single role could occupy several slots
   * (closed *and* recruiter-overdue, or one entry per unanswered contact),
   * and since `cm` shows only the top few, one noisy role would push every
   * other role's alert off the board.
   */
  const push = (role: Role, reason: AttentionReason, detail: string): void => {
    if (attention.some((item) => item.roleId === role.id)) return;
    attention.push({ roleId: role.id, title: role.title, company: companyOf(role), status: role.status, reason, detail });
  };

  for (const role of active) {
    if (role.closed_at != null) {
      push(role, 'closed-not-triaged', `posting closed ${describeAge(role.closed_at)} ago but still sits in "${role.status}"`);
    }
  }

  for (const contact of listRecruiterContacts(db, { overdueDays: settings.recruiter_nudge_days })) {
    // Only active roles: `listRecruiterContacts` filters on an unanswered
    // contact, never on the role's stage, so once the board started
    // including terminal roles this began nagging about follow-ups for
    // roles already marked denied or skipped — forever.
    const role = active.find((candidate) => candidate.id === contact.role_id);
    if (!role) continue;
    push(role, 'recruiter-overdue', `${contact.recruiter_name} contacted ${describeAge(contact.contacted_at)} ago, no reply`);
  }

  const now = new Date().toISOString();
  for (const role of roles) {
    if (role.reapply_after != null && role.reapply_after <= now && role.status === 'denied') {
      push(role, 'reapply-ready', `reapply cooldown ended ${describeAge(role.reapply_after)} ago`);
    }
  }

  for (const role of active) {
    if (role.status_changed_at <= staleCutoff) {
      push(role, 'stale', `nothing has moved in ${describeAge(role.status_changed_at)}`);
    }
  }

  attention.sort((a, b) => ATTENTION_REASONS.indexOf(a.reason) - ATTENTION_REASONS.indexOf(b.reason));

  return { stages, needsAttention: attention, totalActive: active.length };
}
