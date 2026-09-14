import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-funnel-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function backdate(sql: string, ...params: unknown[]): void {
  const db = openDb(path.join(dataDir, 'career-mate.db'));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function seedPipeline(): void {
  runCli(['companies', 'add', 'https://acme.example.com'], { dataDir });
  runCli(['roles', 'add', 'https://acme.example.com/jobs/1', '--company', '1'], { dataDir });
  runCli(['roles', 'add', 'https://acme.example.com/jobs/2', '--company', '1'], { dataDir });
  runCli(['roles', 'set-status', '2', 'applied'], { dataDir });
}

describe('cm with no arguments', () => {
  it('opens on the work, not a help screen', () => {
    seedPipeline();

    const board = runCli([], { dataDir });

    // Discovering the tool by reading --help was the thing that made it
    // feel unusable; the board names the vocabulary while showing state.
    expect(board.exitCode).toBe(0);
    expect(board.stdout).toContain('Pipeline');
    expect(board.stdout).toMatch(/new\s+1/);
    expect(board.stdout).toMatch(/applied\s+1/);
    expect(board.stdout).toMatch(/interviewing\s+0/);
  });

  it('still gives you the command list when you ask for it', () => {
    const help = runCli(['--help'], { dataDir });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('companies');
    expect(help.stdout).toContain('roles');
  });

  it('says so plainly when nothing is tracked yet', () => {
    const board = runCli([], { dataDir });
    expect(board.stdout).toMatch(/Nothing tracked yet/);
  });
});

describe('cm next', () => {
  it('surfaces the things that need doing, worst first', () => {
    seedPipeline();
    // A posting that closed while the role still reads as applied.
    backdate("UPDATE roles SET closed_at = ? WHERE id = 2", new Date().toISOString());
    // A role nothing has moved on.
    backdate(
      'UPDATE roles SET status_changed_at = ? WHERE id = 1',
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const next = runCli(['next'], { dataDir });

    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain('Needs attention (2)');
    expect(next.stdout.indexOf('CLOSED')).toBeLessThan(next.stdout.indexOf('STALE'));
    expect(next.stdout).toMatch(/still sits in "applied"/);
  });

  it('says nothing needs attention when nothing does', () => {
    seedPipeline();
    const next = runCli(['next'], { dataDir });
    expect(next.stdout).toMatch(/Nothing needs attention/);
  });
});
