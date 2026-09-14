import type Database from 'better-sqlite3';
import { loadSettings } from '../config/settings.js';
import { createCompany, findCompanyByUrl, getCompanyById, listCompanies } from '../db/repositories/companies.js';
import { listEventsForEntity } from '../db/repositories/events.js';
import { enqueueJob, enqueueJobOnce } from '../db/repositories/jobs.js';
import { spendSince } from '../db/repositories/model-calls.js';
import { createInterviewNote, listInterviewNotes } from '../db/repositories/interview-notes.js';
import {
  createRecruiterContact,
  listRecruiterContacts,
  markRecruiterContactResponded,
} from '../db/repositories/recruiter-contacts.js';
import {
  createRole,
  findRoleByUrl,
  getRoleById,
  getStatusHistory,
  listRoleIdsNeedingClosureCheck,
  listRoles,
  setReapplyAfter,
  setStatus,
} from '../db/repositories/roles.js';
import { getLatestRoleTips } from '../db/repositories/tips.js';
import { companyStructuralPayload, roleStructuralPayload } from '../domain/enrichment-payload.js';
import { ROLE_STATUSES, type RoleStatus } from '../domain/role-status.js';
import { ensureDaemonRunning } from '../lib/daemon-control.js';
import { buildFunnel } from '../reporting/funnel.js';

/**
 * The action set an agent is allowed to take.
 *
 * This registry *is* the constraint. Model-side devices (`tool_choice`,
 * `strict`) only make the arguments well-formed; what stops a wrong or
 * invented action is that nothing outside this table can be dispatched.
 * Read tools and mutating tools are declared separately and annotated, so
 * a host can treat them differently — the agent equivalent of not letting
 * one confused sentence delete a row.
 *
 * Every tool is implemented over the same repositories the CLI uses. None
 * of them reimplements logic: if the CLI and the agent ever disagreed
 * about what "set the stage" means, the tool would be lying.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (db: Database.Database, args: Record<string, unknown>) => unknown;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new Error(`"${key}" is required and must be a non-empty string`);
  return '';
}

function int(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`"${key}" is required and must be a positive integer`);
  return parsed;
}

function requireRole(db: Database.Database, roleId: number) {
  const role = getRoleById(db, roleId);
  if (!role) throw new Error(`No opportunity #${roleId}. Use list_opportunities to see what exists.`);
  return role;
}

const OBJECT = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const READ = (title: string) => ({ title, readOnlyHint: true });
const WRITE = (title: string, idempotent = false) => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: idempotent,
});

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_pipeline',
    description:
      'The whole job-search funnel: every opportunity grouped by stage, plus what needs attention right now ' +
      'ordered by how costly it is to ignore. Start here for any question about overall state or "what should I do".',
    inputSchema: OBJECT({}),
    annotations: READ('Pipeline overview'),
    handler: (db) => buildFunnel(db, loadSettings()),
  },
  {
    name: 'list_opportunities',
    description:
      'Opportunities, optionally filtered to one stage. When no stage is given, terminal stages ' +
      '(success/denied/skip) are excluded unless include_terminal is true; asking for a stage by name always returns it.',
    inputSchema: OBJECT({
      stage: { type: 'string', enum: [...ROLE_STATUSES], description: 'Restrict to a single stage' },
      include_terminal: { type: 'boolean', description: 'Include success/denied/skip' },
    }),
    annotations: READ('List opportunities'),
    handler: (db, args) => {
      // Validated rather than cast: a client that does not enforce the
      // schema and sends "Applied" would otherwise get an empty array, and
      // the model would conclude the stage is empty rather than learn its
      // argument was wrong.
      const stage = args.stage === undefined ? undefined : (str(args, 'stage') as RoleStatus);
      if (stage !== undefined && !ROLE_STATUSES.includes(stage)) {
        throw new Error(`"${stage}" is not a stage. One of: ${ROLE_STATUSES.join(', ')}`);
      }
      return listRoles(db, { status: stage, includeTerminal: Boolean(args.include_terminal) });
    },
  },
  {
    name: 'get_opportunity',
    description:
      'Everything known about one opportunity: its fields, company, stage history, interview notes, ' +
      'recruiter contacts, latest researched tips, and audit trail.',
    inputSchema: OBJECT({ opportunity_id: { type: 'integer', description: 'The role id' } }, ['opportunity_id']),
    annotations: READ('Opportunity detail'),
    handler: (db, args) => {
      const role = requireRole(db, int(args, 'opportunity_id'));
      return {
        opportunity: role,
        company: role.company_id != null ? getCompanyById(db, role.company_id) : null,
        stageHistory: getStatusHistory(db, role.id),
        interviewNotes: listInterviewNotes(db, role.id),
        recruiterContacts: listRecruiterContacts(db, { roleId: role.id }),
        tips: getLatestRoleTips(db, role.id) ?? null,
        events: listEventsForEntity(db, 'role', role.id),
      };
    },
  },
  {
    name: 'list_companies',
    description: 'Every tracked company, with its researched fields and your manual preference rating.',
    inputSchema: OBJECT({}),
    annotations: READ('List companies'),
    handler: (db) => listCompanies(db),
  },
  {
    name: 'get_spend',
    description: 'What the tool has cost to run: model spend over the last 7 and 30 days, and the number of calls.',
    inputSchema: OBJECT({}),
    annotations: READ('Model spend'),
    handler: (db) => {
      const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      return { last7Days: spendSince(db, since(7)), last30Days: spendSince(db, since(30)) };
    },
  },
  {
    name: 'add_opportunity',
    description:
      'Track a job posting by URL. Enrichment (title, company, compensation, remote/EU) runs in the background. ' +
      'Adding a URL already tracked returns the existing opportunity rather than creating a duplicate.',
    inputSchema: OBJECT(
      {
        url: { type: 'string', description: 'The job posting URL' },
        company_id: { type: 'integer', description: 'Optional; resolved from the page when omitted' },
      },
      ['url'],
    ),
    annotations: WRITE('Add opportunity', true),
    handler: (db, args) => {
      const url = str(args, 'url');
      const companyId = args.company_id == null ? null : int(args, 'company_id');

      const existing = findRoleByUrl(db, url, companyId);
      if (existing) return { created: false, opportunity: existing };

      const role = createRole(db, { companyId, url });
      enqueueJob(db, { topic: 'enrichment', payload: roleStructuralPayload(role.id) });
      ensureDaemonRunning();
      return { created: true, opportunity: role };
    },
  },
  {
    name: 'add_company',
    description: 'Track a company by URL. Its details and research run in the background.',
    inputSchema: OBJECT({ url: { type: 'string' } }, ['url']),
    annotations: WRITE('Add company', true),
    handler: (db, args) => {
      const url = str(args, 'url');
      const existing = findCompanyByUrl(db, url);
      if (existing) return { created: false, company: existing };

      const company = createCompany(db, url);
      enqueueJob(db, { topic: 'enrichment', payload: companyStructuralPayload(company.id) });
      ensureDaemonRunning();
      return { created: true, company };
    },
  },
  {
    name: 'set_stage',
    description:
      'Move an opportunity to a different stage. Moving to "denied" sets a reapply date using the configured cooldown. ' +
      'The note is recorded in the stage history — say why, not just what.',
    inputSchema: OBJECT(
      {
        opportunity_id: { type: 'integer' },
        stage: { type: 'string', enum: [...ROLE_STATUSES] },
        note: { type: 'string', description: 'Why it moved' },
      },
      ['opportunity_id', 'stage'],
    ),
    annotations: WRITE('Set stage'),
    handler: (db, args) => {
      const roleId = int(args, 'opportunity_id');
      requireRole(db, roleId);
      const stage = str(args, 'stage') as RoleStatus;
      if (!ROLE_STATUSES.includes(stage)) throw new Error(`"${stage}" is not a stage. One of: ${ROLE_STATUSES.join(', ')}`);
      return setStatus(db, roleId, stage, str(args, 'note', false) || 'set via agent');
    },
  },
  {
    name: 'add_interview_note',
    description: 'Record a note from an interview stage, so it can inform later preparation.',
    inputSchema: OBJECT(
      {
        opportunity_id: { type: 'integer' },
        stage: { type: 'string', description: 'Freeform, e.g. "phone screen", "system design"' },
        notes: { type: 'string' },
      },
      ['opportunity_id', 'stage', 'notes'],
    ),
    annotations: WRITE('Add interview note'),
    handler: (db, args) => {
      const roleId = int(args, 'opportunity_id');
      requireRole(db, roleId);
      return createInterviewNote(db, { roleId, stage: str(args, 'stage'), notes: str(args, 'notes') });
    },
  },
  {
    name: 'log_recruiter_contact',
    description: 'Record that you contacted (or were contacted by) a recruiter about an opportunity.',
    inputSchema: OBJECT(
      {
        opportunity_id: { type: 'integer' },
        recruiter_name: { type: 'string' },
        channel: { type: 'string', description: 'e.g. email, LinkedIn' },
        link: { type: 'string' },
        notes: { type: 'string' },
      },
      ['opportunity_id', 'recruiter_name'],
    ),
    annotations: WRITE('Log recruiter contact'),
    handler: (db, args) => {
      const roleId = int(args, 'opportunity_id');
      requireRole(db, roleId);
      return createRecruiterContact(db, {
        roleId,
        recruiterName: str(args, 'recruiter_name'),
        channel: str(args, 'channel', false) || 'unspecified',
        link: str(args, 'link', false) || undefined,
        notes: str(args, 'notes', false) || undefined,
      });
    },
  },
  {
    name: 'mark_recruiter_replied',
    description: 'Record that a recruiter replied, which clears the follow-up reminder.',
    inputSchema: OBJECT({ contact_id: { type: 'integer' } }, ['contact_id']),
    annotations: WRITE('Mark recruiter replied', true),
    handler: (db, args) => {
      const contact = markRecruiterContactResponded(db, int(args, 'contact_id'));
      if (!contact) throw new Error(`No recruiter contact #${args.contact_id}`);
      return contact;
    },
  },
  {
    name: 'set_reapply_date',
    description: 'Change when an opportunity becomes worth reapplying to.',
    inputSchema: OBJECT(
      { opportunity_id: { type: 'integer' }, date: { type: 'string', description: 'ISO date, e.g. 2026-12-01' } },
      ['opportunity_id', 'date'],
    ),
    annotations: WRITE('Set reapply date', true),
    handler: (db, args) => {
      const roleId = int(args, 'opportunity_id');
      requireRole(db, roleId);
      const date = str(args, 'date');
      if (Number.isNaN(Date.parse(date))) throw new Error(`"${date}" is not a date I can parse. Use ISO, e.g. 2026-12-01.`);
      return setReapplyAfter(db, roleId, new Date(date).toISOString());
    },
  },
  {
    name: 'request_tips',
    description:
      'Queue cited research on how to approach an opportunity (culture, interview process, negotiation). ' +
      'Returns immediately; read the result later with get_opportunity. Costs money — this calls the model.',
    inputSchema: OBJECT(
      {
        opportunity_id: { type: 'integer' },
        refresh: { type: 'boolean', description: 'Research again even if tips already exist' },
      },
      ['opportunity_id'],
    ),
    annotations: WRITE('Research tips'),
    handler: (db, args) => {
      const roleId = int(args, 'opportunity_id');
      const role = requireRole(db, roleId);
      if (role.company_id == null) throw new Error(`Opportunity #${roleId} has no company resolved yet; tips need one.`);

      // Mirrors `cm tips`: return what exists rather than paying again.
      // Without this, an agent that calls the tool, sees nothing yet and
      // calls again — the loop this tool's own "read the result later"
      // wording invites — pays for a second full research run.
      const existing = getLatestRoleTips(db, roleId);
      if (existing && !args.refresh) return { queued: false, tips: existing };

      // And once queued, repeated asking must not queue it twice.
      const job = enqueueJobOnce(db, { topic: 'tips', payload: { kind: 'role-tips', roleId } });
      ensureDaemonRunning();
      return { queued: true, alreadyQueued: job === undefined, jobId: job?.id ?? null };
    },
  },
  {
    name: 'refresh_postings',
    description:
      'Re-check every active opportunity for whether its posting has closed. Returns immediately; ' +
      'closures show up in get_pipeline as things needing attention. Costs money for postings it cannot settle for free.',
    inputSchema: OBJECT({}),
    annotations: WRITE('Refresh postings', true),
    handler: (db) => {
      const roleIds = listRoleIdsNeedingClosureCheck(db);
      for (const roleId of roleIds) {
        enqueueJob(db, { topic: 'refresh', payload: { kind: 'role-closure-check', roleId } });
      }
      if (roleIds.length > 0) ensureDaemonRunning();
      return { queued: roleIds.length };
    },
  },
  {
    name: 'discover_opportunities',
    description:
      'Search tracked companies for new roles matching your preferences. Returns immediately; ' +
      'new opportunities appear in get_pipeline. Costs money — this runs a web search per company.',
    inputSchema: OBJECT({}),
    annotations: WRITE('Discover opportunities'),
    handler: (db) => {
      const companies = listCompanies(db);
      for (const company of companies) {
        enqueueJob(db, { topic: 'discovery', payload: { kind: 'company-discover', companyId: company.id } });
      }
      if (companies.length > 0) ensureDaemonRunning();
      return { queued: companies.length };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
