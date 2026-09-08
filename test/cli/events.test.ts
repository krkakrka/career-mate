import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { recordEvent } from '../../src/db/repositories/events.js';
import { createNotification } from '../../src/db/repositories/notifications.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-events-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm events', () => {
  it('shows recorded events for an entity in order', () => {
    const db = openDb(dbPath);
    recordEvent(db, {
      entityType: 'role',
      entityId: 1,
      type: 'role.added',
      context: { url: 'https://example.com/jobs/1' },
    });
    recordEvent(db, { entityType: 'role', entityId: 1, type: 'role.status_changed', context: { to: 'applied' } });
    db.close();

    const result = runCli(['events', 'role', '1'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('role.added');
    expect(result.stdout).toContain('role.status_changed');
    expect(result.stdout.indexOf('role.added')).toBeLessThan(result.stdout.indexOf('role.status_changed'));
  });

  it('does not show events recorded for a different entity id or type', () => {
    const db = openDb(dbPath);
    recordEvent(db, { entityType: 'role', entityId: 2, type: 'role.added' });
    recordEvent(db, { entityType: 'company', entityId: 1, type: 'company.added' });
    db.close();

    const result = runCli(['events', 'role', '1'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no events/i);
  });

  it('says so when there are no events yet', () => {
    openDb(dbPath).close();
    const result = runCli(['events', 'role', '999'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no events/i);
  });

  it('rejects an unrecognized entity type', () => {
    const result = runCli(['events', 'widget', '1'], { dataDir });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('cm inbox', () => {
  it('shows an unacknowledged notification, and hides it once acked', () => {
    const db = openDb(dbPath);
    const event = recordEvent(db, { entityType: 'role', entityId: 1, type: 'role.closed' });
    createNotification(db, { eventId: event.id, message: 'Role #1 closed' });
    db.close();

    const before = runCli(['inbox'], { dataDir });
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain('Role #1 closed');
    expect(before.stdout).toContain('[new]');

    const ack = runCli(['inbox', 'ack', '1'], { dataDir });
    expect(ack.exitCode).toBe(0);

    const after = runCli(['inbox'], { dataDir });
    expect(after.stdout).toMatch(/inbox is empty/i);
  });

  it('says so when the inbox is empty', () => {
    openDb(dbPath).close();
    const result = runCli(['inbox'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/inbox is empty/i);
  });

  it('rejects acknowledging an unknown notification', () => {
    openDb(dbPath).close();
    const result = runCli(['inbox', 'ack', '999'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });
});
