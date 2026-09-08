import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-roles-'));
  const addCompany = runCli(['companies', 'add', 'https://example.com'], { dataDir });
  expect(addCompany.exitCode).toBe(0);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm roles', () => {
  it('adds a role under a company and shows it', () => {
    const add = runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('Added role #1 for company #1');

    const show = runCli(['roles', 'show', '1'], { dataDir });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('https://example.com/jobs/1');
    expect(show.stdout).toContain('Status: new');
  });

  it('rejects adding a role to a nonexistent company', () => {
    const result = runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '999'], {
      dataDir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/company #999 not found/i);
  });

  it('blocks a duplicate-looking url without --force, allows it with --force', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });

    const blocked = runCli(['roles', 'add', 'https://example.com/jobs/1/', '--company', '1'], {
      dataDir,
    });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toMatch(/already tracks.*force/i);

    const forced = runCli(
      ['roles', 'add', 'https://example.com/jobs/1/', '--company', '1', '--force'],
      { dataDir },
    );
    expect(forced.exitCode).toBe(0);

    const list = runCli(['roles', 'list'], { dataDir });
    const roleLines = list.stdout.trim().split('\n');
    expect(roleLines).toHaveLength(2);
  });

  it('records a status change with context in the history', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    const setStatus = runCli(
      ['roles', 'set-status', '1', 'applied', '--note', 'Applied via careers page'],
      { dataDir },
    );
    expect(setStatus.exitCode).toBe(0);

    const show = runCli(['roles', 'show', '1'], { dataDir });
    expect(show.stdout).toContain('Status: applied');
    expect(show.stdout).toContain('new -> applied');
    expect(show.stdout).toContain('Applied via careers page');
  });

  it('rejects an unrecognized status value', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    const result = runCli(['roles', 'set-status', '1', 'not-a-real-status'], { dataDir });
    expect(result.exitCode).not.toBe(0);
  });

  it('auto-sets reapply-after to about one month out when marked denied', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    const result = runCli(['roles', 'set-status', '1', 'denied'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/reapply after/i);

    const show = runCli(['roles', 'show', '1'], { dataDir });
    const match = show.stdout.match(/Reapply after: (\S+)/);
    expect(match).not.toBeNull();

    const reapplyDate = new Date(match![1]!);
    const expected = new Date();
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(Math.abs(reapplyDate.getTime() - expected.getTime())).toBeLessThan(60_000);
  });

  it('set-reapply overrides the auto-computed reapply-after date', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    runCli(['roles', 'set-status', '1', 'denied'], { dataDir });

    const override = runCli(['roles', 'set-reapply', '1', '2027-01-15'], { dataDir });
    expect(override.exitCode).toBe(0);

    const show = runCli(['roles', 'show', '1'], { dataDir });
    expect(show.stdout).toContain('2027-01-15');
  });

  it('list defaults to active statuses, hiding terminal ones unless asked for', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    runCli(['roles', 'set-status', '1', 'denied'], { dataDir });

    const defaultList = runCli(['roles', 'list'], { dataDir });
    expect(defaultList.stdout).toMatch(/no roles match/i);

    const deniedList = runCli(['roles', 'list', '--status', 'denied'], { dataDir });
    expect(deniedList.stdout).toContain('#1');
  });

  it('filters list by status and by company', () => {
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    runCli(['roles', 'add', 'https://example.com/jobs/2', '--company', '1'], { dataDir });
    runCli(['roles', 'set-status', '2', 'applied'], { dataDir });

    const applied = runCli(['roles', 'list', '--status', 'applied'], { dataDir });
    const lines = applied.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^#2\s/);
  });
});
