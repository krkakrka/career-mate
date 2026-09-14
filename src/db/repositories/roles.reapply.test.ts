import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../../test/helpers/env.js';
import { openDb } from '../client.js';
import { addMonthsIso, createRole, setStatus } from './roles.js';

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-reapply-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('addMonthsIso', () => {
  it('adds whole months on an ordinary date', () => {
    expect(addMonthsIso(new Date('2026-03-15T10:00:00.000Z'), 1)).toBe('2026-04-15T10:00:00.000Z');
    expect(addMonthsIso(new Date('2026-03-15T10:00:00.000Z'), 3)).toBe('2026-06-15T10:00:00.000Z');
  });

  it('clamps to the end of a shorter month instead of overflowing into the next one', () => {
    // `setUTCMonth(+1)` alone turns 31 January into 3 March, silently adding
    // three days to the wait and putting the date in the wrong month — a
    // role denied at the end of January would reappear in March.
    expect(addMonthsIso(new Date('2026-01-31T00:00:00.000Z'), 1)).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonthsIso(new Date('2026-05-31T00:00:00.000Z'), 1)).toBe('2026-06-30T00:00:00.000Z');
  });

  it('knows which Februaries have 29 days', () => {
    expect(addMonthsIso(new Date('2028-01-31T00:00:00.000Z'), 1)).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rolls the year over', () => {
    expect(addMonthsIso(new Date('2026-11-15T00:00:00.000Z'), 2)).toBe('2027-01-15T00:00:00.000Z');
    expect(addMonthsIso(new Date('2026-01-15T00:00:00.000Z'), 12)).toBe('2027-01-15T00:00:00.000Z');
  });

  it('treats zero months as "right now"', () => {
    // A legitimate setting — "no cooldown, reapply whenever" — and the field
    // still reads as a moment you may reapply from.
    expect(addMonthsIso(new Date('2026-03-15T10:00:00.000Z'), 0)).toBe('2026-03-15T10:00:00.000Z');
  });
});

describe('setStatus reapply cooldown', () => {
  /** The instant is injected, so the expected date is exact rather than a tolerance. */
  const DENIED_AT = new Date('2026-01-31T12:00:00.000Z');

  function denyWith(cooldownMonths: number, now = DENIED_AT): string {
    const role = createRole(db, { url: `https://example.com/jobs/${cooldownMonths}-${Math.random()}` });
    return setStatus(db, role.id, 'denied', 'no thanks', { cooldownMonths, now }).reapply_after!;
  }

  it('uses the configured cooldown rather than a hardcoded month', () => {
    // `reapply_cooldown_months` was loaded, coerced and typed from the start
    // and read by nothing — every denial got one month.
    //
    // Asserted exactly, against an injected instant. Comparing two
    // independently-taken `new Date()` values needed a tolerance, and could
    // straddle a month boundary: a denial at 23:59:59.999 on 31 January
    // gives 28 February, while the expectation computed a millisecond later
    // gives 1 March — a whole day apart, intermittently.
    expect(denyWith(0)).toBe('2026-01-31T12:00:00.000Z');
    expect(denyWith(1)).toBe('2026-02-28T12:00:00.000Z');
    expect(denyWith(2)).toBe('2026-03-31T12:00:00.000Z');
    expect(denyWith(6)).toBe('2026-07-31T12:00:00.000Z');
  });

  it('reads the setting when no cooldown is passed', () => {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'config', 'settings.json'), JSON.stringify({ reapply_cooldown_months: 6 }));

    const role = createRole(db, { url: 'https://example.com/jobs/from-settings' });
    const denied = setStatus(db, role.id, 'denied', undefined, { now: DENIED_AT });

    expect(denied.reapply_after).toBe('2026-07-31T12:00:00.000Z');
  });

  it('does not read settings at all for a status that has no cooldown', () => {
    // Reading them unconditionally broke `cm roles set-status 5 applied` on a
    // malformed settings.json — a command with nothing to do with cooldowns
    // — because loadJsonConfig throws by design.
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'config', 'settings.json'), '{ not json');

    const role = createRole(db, { url: 'https://example.com/jobs/no-config-read' });
    expect(() => setStatus(db, role.id, 'applied')).not.toThrow();
    expect(() => setStatus(db, role.id, 'denied')).toThrow();
  });

  it('refuses a cooldown that cannot produce a real date', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/absurd' });
    expect(() => setStatus(db, role.id, 'denied', undefined, { cooldownMonths: 1e15 })).toThrow(
      /not a representable date/,
    );
  });

  it('leaves an existing reapply date alone for every other status', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/other' });
    const denied = setStatus(db, role.id, 'denied', undefined, { cooldownMonths: 2, now: DENIED_AT });

    const applied = setStatus(db, role.id, 'applied');

    expect(applied.reapply_after).toBe(denied.reapply_after);
  });
});
