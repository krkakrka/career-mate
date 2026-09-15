import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreEnv } from '../../../test/helpers/env.js';
import { openDb } from '../../db/client.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import { listOperationalLogs } from '../../db/repositories/operational-logs.js';
import { handleNotificationJob } from './notification.js';

vi.mock('../../notify/macos.js', () => ({
  deliverMacosNotification: vi.fn(async () => ({ delivered: true })),
}));
const { deliverMacosNotification } = await import('../../notify/macos.js');

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-notify-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
  vi.mocked(deliverMacosNotification).mockClear();
  vi.mocked(deliverMacosNotification).mockResolvedValue({ delivered: true });
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function setChannel(notification_channel: string): void {
  fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'config', 'settings.json'), JSON.stringify({ notification_channel }));
}

function notificationJob(payload: Record<string, unknown> = {}): JobRecord {
  return enqueueJob(db, {
    topic: 'notification',
    payload: {
      entityType: 'role',
      entityId: null,
      eventType: 'role.closed',
      message: 'Staff Engineer at Acme has closed',
      ...payload,
    },
  });
}

/** Null-safe, so a case that inserted nothing fails as a missing row rather than a TypeError. */
const channelOf = (): string | null | undefined =>
  (db.prepare('SELECT channel FROM notifications ORDER BY id DESC LIMIT 1').get() as
    | { channel: string | null }
    | undefined)?.channel;

describe('handleNotificationJob channels', () => {
  it('defaults to the terminal, as it always has', async () => {
    await handleNotificationJob(db, notificationJob());

    expect(deliverMacosNotification).not.toHaveBeenCalled();
    expect(channelOf()).toBe('terminal');
  });

  it('draws a banner when the setting asks for one', async () => {
    // Without a setting selecting it, no producer ever names a channel — so
    // `macos` would be typed and unreachable, shipping dead.
    setChannel('macos');

    await handleNotificationJob(db, notificationJob());

    expect(deliverMacosNotification).toHaveBeenCalledWith('Staff Engineer at Acme has closed');
    expect(channelOf()).toBe('macos');
  });

  it('does both when asked', async () => {
    // The terminal half is asserted too: without it, a regression dropping
    // `'both'` from the printing condition passes.
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      setChannel('both');
      await handleNotificationJob(db, notificationJob());

      expect(deliverMacosNotification).toHaveBeenCalledTimes(1);
      expect(printed).toHaveBeenCalled();
      expect(channelOf()).toBe('both');
    } finally {
      printed.mockRestore();
    }
  });

  it('lets a payload override the setting', async () => {
    setChannel('macos');
    await handleNotificationJob(db, notificationJob({ channel: 'terminal' }));
    expect(deliverMacosNotification).not.toHaveBeenCalled();
    // Asserted, so an override that silently landed as something else fails.
    expect(channelOf()).toBe('terminal');
  });

  it('coerces a channel the payload made up', async () => {
    // `payload.channel` is JSON.parse output despite its type. An older
    // queued row saying "slack" would otherwise match neither branch: a row
    // with delivered_at set, nothing printed, no banner, no log.
    await handleNotificationJob(db, notificationJob({ channel: 'slack' }));

    expect(channelOf()).toBe('terminal');
    expect(deliverMacosNotification).not.toHaveBeenCalled();
  });

  it('still records the notification when settings.json is malformed', async () => {
    // `loadJsonConfig` throws by design, and this read happens before the
    // event and notification rows are written — so unguarded, a JSON typo
    // failed the job through every retry and destroyed the durable record
    // the handler exists to create, over a cosmetic delivery preference.
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'config', 'settings.json'), '{ not json');

    await expect(handleNotificationJob(db, notificationJob())).resolves.toBeUndefined();
    expect(channelOf()).toBe('terminal');
  });

  it('records the notification even when the banner fails, and does not fail the job', async () => {
    // The durable record is the row; losing a queue item because a banner
    // could not be drawn would trade it for the ephemeral one.
    setChannel('macos');
    vi.mocked(deliverMacosNotification).mockResolvedValue({ delivered: false, reason: 'not macOS (linux)' });

    await expect(handleNotificationJob(db, notificationJob())).resolves.toBeUndefined();

    expect(channelOf()).toBe('macos');
    const logged = listOperationalLogs(db, { action: 'macos-banner' });
    expect(logged.length).toBe(1);
    expect(JSON.parse(logged[0]!.context!).reason).toBe('not macOS (linux)');
  });

  it('falls back to the terminal for a nonsensical setting', async () => {
    // A misspelled channel must not silently mean "deliver nowhere".
    setChannel('banner');
    await handleNotificationJob(db, notificationJob());
    expect(channelOf()).toBe('terminal');
  });
});
