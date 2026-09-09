import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;

function expectNoRawCrash(stderr: string): void {
  expect(stderr).not.toMatch(/\bat\s+\S+\s+\(/);
  expect(stderr).not.toMatch(/\bTypeError\b|\bReferenceError\b/);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-interview-notes-cli-'));
  const addCompany = runCli(['companies', 'add', 'https://example.com'], { dataDir });
  expect(addCompany.exitCode).toBe(0);
  const addRole = runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
  expect(addRole.exitCode).toBe(0);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm interview-note add', () => {
  it('adds a note and it shows up in `cm roles show`', () => {
    const add = runCli(
      ['interview-note', 'add', '1', '--stage', 'phone screen', '--notes', 'Went well, asked about system design'],
      { dataDir },
    );
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('Added interview note #1');

    const show = runCli(['roles', 'show', '1'], { dataDir });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('Interview notes:');
    expect(show.stdout).toContain('[phone screen]');
    expect(show.stdout).toContain('Went well, asked about system design');
  });

  it('rejects adding a note for an unknown role, cleanly (not a raw stack trace)', () => {
    const result = runCli(['interview-note', 'add', '999', '--stage', 'screen', '--notes', 'x'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/role #999 not found/i);
    expectNoRawCrash(result.stderr);
  });
});

describe('cm roles show — recruiter contacts integration', () => {
  it('shows recruiter contacts alongside status history and interview notes', () => {
    runCli(['recruiters', 'ping', '1', '--name', 'Jane Recruiter'], { dataDir });

    const show = runCli(['roles', 'show', '1'], { dataDir });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('Recruiter contacts:');
    expect(show.stdout).toContain('Jane Recruiter');
    expect(show.stdout).toContain('(no response yet)');
  });

  it('shows nothing extra for a role with no contacts or notes', () => {
    const show = runCli(['roles', 'show', '1'], { dataDir });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).not.toContain('Recruiter contacts:');
    expect(show.stdout).not.toContain('Interview notes:');
  });
});
