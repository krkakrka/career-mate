import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { openDb } from '../db/client.js';
import { listJobs } from '../db/repositories/jobs.js';
import { createCompany } from '../db/repositories/companies.js';
import { createRole } from '../db/repositories/roles.js';
import { createRoleTips } from '../db/repositories/tips.js';
import { TOOLS_BY_NAME } from './tools.js';

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-mcp-tools-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  process.env.CM_DISABLE_DAEMON_AUTOSTART = '1';
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}): unknown =>
  TOOLS_BY_NAME.get(name)!.handler(db, args);

describe('request_tips', () => {
  function seedRole(): number {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    return createRole(db, { companyId: company.id, url: 'https://acme.example.com/jobs/1' }).id;
  }

  it('returns what already exists rather than paying to research it again', () => {
    const roleId = seedRole();
    createRoleTips(db, roleId, 'existing tips', []);

    const response = call('request_tips', { opportunity_id: roleId }) as { queued: boolean };

    // An agent that calls this, sees nothing yet and calls again — the loop
    // the tool's own wording invites — must not buy a second research run.
    expect(response.queued).toBe(false);
    expect(listJobs(db).filter((job) => job.topic === 'tips')).toHaveLength(0);
  });

  it('researches again when explicitly asked to', () => {
    const roleId = seedRole();
    createRoleTips(db, roleId, 'existing tips', []);

    expect(call('request_tips', { opportunity_id: roleId, refresh: true })).toMatchObject({ queued: true });
    expect(listJobs(db).filter((job) => job.topic === 'tips')).toHaveLength(1);
  });

  it('queues once however many times it is asked', () => {
    const roleId = seedRole();

    call('request_tips', { opportunity_id: roleId });
    const second = call('request_tips', { opportunity_id: roleId }) as { alreadyQueued: boolean };

    expect(second.alreadyQueued).toBe(true);
    expect(listJobs(db).filter((job) => job.topic === 'tips')).toHaveLength(1);
  });

  it('explains itself when the company is not resolved yet', () => {
    const roleId = createRole(db, { url: 'https://acme.example.com/jobs/1' }).id;
    expect(() => call('request_tips', { opportunity_id: roleId })).toThrow(/no company resolved/i);
  });
});

describe('list_opportunities', () => {
  it('tells the model its argument was wrong instead of returning nothing', () => {
    // A client that does not enforce the schema sends "Applied"; an empty
    // array would read as "that stage is empty", which is a different and
    // wrong conclusion.
    expect(() => call('list_opportunities', { stage: 'Applied' })).toThrow(/is not a stage/);
  });

  it('returns a terminal stage when asked for it by name', () => {
    const roleId = createRole(db, { url: 'https://acme.example.com/jobs/1' }).id;
    db.prepare("UPDATE roles SET status = 'denied' WHERE id = ?").run(roleId);

    expect(call('list_opportunities', { stage: 'denied' })).toHaveLength(1);
    // ...but not by default.
    expect(call('list_opportunities')).toHaveLength(0);
  });
});
