import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../client.js';
import { listOperationalLogs, recordOperationalLog, sanitizeOperationalValue } from './operational-logs.js';
import { enqueueJob } from './jobs.js';

let dir: string;
let db: Database.Database;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-logs-')); db = openDb(path.join(dir, 'db.sqlite')); });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('operational logs', () => {
  it('filters logs by entity and job correlation', () => {
    recordOperationalLog(db, { outcome: 'succeeded', component: 'cli', action: 'companies.add', entityType: 'company', entityId: 4 });
    const job = enqueueJob(db, { topic: 'notification' });
    recordOperationalLog(db, { outcome: 'failed', component: 'worker', action: 'handler', jobId: job.id });
    expect(listOperationalLogs(db, { entityType: 'company', entityId: 4 })).toHaveLength(1);
    expect(listOperationalLogs(db, { jobId: job.id })[0]?.action).toBe('handler');
  });

  it('redacts secrets and omits raw external content', () => {
    const log = recordOperationalLog(db, {
      outcome: 'failed', component: 'fetch', action: 'page',
      context: { authorization: 'Bearer do-not-store', cookie: 'session', html: '<body>private</body>', url: 'https://example.com/path?token=private#fragment' },
      error: new Error('request failed with password=hunter2'),
    });
    expect(log.context).not.toContain('do-not-store');
    expect(log.context).not.toContain('private</body>');
    expect(log.context).toContain('https://example.com/path');
    expect(log.context).not.toContain('?token');
    expect(log.error).not.toContain('hunter2');
  });

  it('redacts a bearer token that follows a labeled header, not just the header word itself', () => {
    // Regression: the key=value pass used to run first and greedily
    // consume just the word "Bearer" (stopping at the next space) as if it
    // were the secret value, leaving the real token completely unredacted.
    const sanitized = sanitizeOperationalValue('Request failed: Authorization: Bearer sk-ant-abcdef123456');
    expect(sanitized).not.toContain('sk-ant-abcdef123456');
  });

  it('redacts a secret embedded in JSON-quoted text, not just "key: value"/"key=value" text', () => {
    // Regression: the key=value regex required whitespace directly between
    // the key and its separator, so `"token":"value"` (no whitespace, and
    // quotes around both sides) never matched at all.
    const sanitized = sanitizeOperationalValue(JSON.stringify({ token: 'abc123secretvalue' }));
    expect(sanitized).not.toContain('abc123secretvalue');
  });
});
