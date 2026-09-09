import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliResult } from '../helpers/run-cli.js';

const cliEntry = fileURLToPath(new URL('../../bin/cm.js', import.meta.url));

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-smoke-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A "crash" here means an uncaught exception leaked a raw Node stack trace
 * to the user, as opposed to our own deliberate `console.error(message)` +
 * non-zero exit. This is the actual thing this suite exists to catch — a
 * command silently regressing from "clean error" to "stack trace."
 */
function expectNoRawCrash(result: CliResult): void {
  expect(result.stderr).not.toMatch(/\bat\s+\S+\s+\(/); // stack frame line
  expect(result.stderr).not.toMatch(/Unhandled/i);
  expect(result.stderr).not.toMatch(/\bTypeError\b|\bReferenceError\b/);
}

interface SmokeCase {
  name: string;
  args: string[];
  expectExitCode: number;
}

/** Every currently-implemented read-only command, run against a totally empty database. */
const EMPTY_STATE_CASES: SmokeCase[] = [
  { name: 'top-level help', args: ['--help'], expectExitCode: 0 },
  { name: 'top-level version', args: ['--version'], expectExitCode: 0 },
  { name: 'companies list', args: ['companies', 'list'], expectExitCode: 0 },
  { name: 'companies show (unknown id)', args: ['companies', 'show', '1'], expectExitCode: 1 },
  { name: 'roles list', args: ['roles', 'list'], expectExitCode: 0 },
  { name: 'roles list --status applied', args: ['roles', 'list', '--status', 'applied'], expectExitCode: 0 },
  { name: 'roles list --sort priority', args: ['roles', 'list', '--sort', 'priority'], expectExitCode: 0 },
  { name: 'roles show (unknown id)', args: ['roles', 'show', '1'], expectExitCode: 1 },
  { name: 'events for a role (none recorded)', args: ['events', 'role', '1'], expectExitCode: 0 },
  { name: 'events for a company (none recorded)', args: ['events', 'company', '1'], expectExitCode: 0 },
  { name: 'inbox', args: ['inbox'], expectExitCode: 0 },
  { name: 'daemon status', args: ['daemon', 'status'], expectExitCode: 0 },
  { name: 'worker status', args: ['worker', 'status'], expectExitCode: 0 },
  { name: 'recruiters list', args: ['recruiters', 'list'], expectExitCode: 0 },
  { name: 'recruiters list --overdue', args: ['recruiters', 'list', '--overdue'], expectExitCode: 0 },
  { name: 'status', args: ['status'], expectExitCode: 0 },
  { name: 'worker jobs', args: ['worker', 'jobs'], expectExitCode: 0 },
  { name: 'worker failed', args: ['worker', 'failed'], expectExitCode: 0 },
  { name: 'logs', args: ['logs'], expectExitCode: 0 },
];

describe('read-only commands against an empty database', () => {
  for (const testCase of EMPTY_STATE_CASES) {
    it(`${testCase.name} exits ${testCase.expectExitCode}, no crash`, () => {
      const result = runCli(testCase.args, { dataDir });
      expectNoRawCrash(result);
      expect(result.exitCode).toBe(testCase.expectExitCode);
    });
  }
});

describe('read-only commands against seeded data', () => {
  beforeEach(() => {
    const addCompany = runCli(['companies', 'add', 'https://example.com'], { dataDir });
    expect(addCompany.exitCode).toBe(0);
    const addRole = runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });
    expect(addRole.exitCode).toBe(0);
    const setStatus = runCli(['roles', 'set-status', '1', 'applied'], { dataDir });
    expect(setStatus.exitCode).toBe(0);
  });

  const SEEDED_STATE_CASES: SmokeCase[] = [
    { name: 'companies list', args: ['companies', 'list'], expectExitCode: 0 },
    { name: 'companies show (known id)', args: ['companies', 'show', '1'], expectExitCode: 0 },
    { name: 'roles list', args: ['roles', 'list'], expectExitCode: 0 },
    { name: 'roles list --status applied', args: ['roles', 'list', '--status', 'applied'], expectExitCode: 0 },
    { name: 'roles list --company', args: ['roles', 'list', '--company', '1'], expectExitCode: 0 },
    { name: 'roles show (known id)', args: ['roles', 'show', '1'], expectExitCode: 0 },
    { name: 'events for the seeded role', args: ['events', 'role', '1'], expectExitCode: 0 },
    { name: 'inbox', args: ['inbox'], expectExitCode: 0 },
    { name: 'daemon status', args: ['daemon', 'status'], expectExitCode: 0 },
    { name: 'worker status', args: ['worker', 'status'], expectExitCode: 0 },
    { name: 'recruiters list', args: ['recruiters', 'list'], expectExitCode: 0 },
    { name: 'recruiters list --role', args: ['recruiters', 'list', '--role', '1'], expectExitCode: 0 },
    { name: 'status', args: ['status'], expectExitCode: 0 },
    { name: 'worker jobs', args: ['worker', 'jobs'], expectExitCode: 0 },
    { name: 'logs', args: ['logs'], expectExitCode: 0 },
  ];

  for (const testCase of SEEDED_STATE_CASES) {
    it(`${testCase.name} exits ${testCase.expectExitCode}, no crash`, () => {
      const result = runCli(testCase.args, { dataDir });
      expectNoRawCrash(result);
      expect(result.exitCode).toBe(testCase.expectExitCode);
    });
  }

  it('companies show reflects the seeded company', () => {
    const result = runCli(['companies', 'show', '1'], { dataDir });
    expect(result.stdout).toContain('https://example.com');
  });

  it('roles show reflects the seeded role and its status change', () => {
    const result = runCli(['roles', 'show', '1'], { dataDir });
    expect(result.stdout).toContain('https://example.com/jobs/1');
    expect(result.stdout).toContain('Status: applied');
    expect(result.stdout).toContain('new -> applied');
  });

  it('roles list --status applied shows the role; the default view hides it once terminal', () => {
    const applied = runCli(['roles', 'list', '--status', 'applied'], { dataDir });
    expect(applied.stdout).toContain('#1');

    runCli(['roles', 'set-status', '1', 'denied'], { dataDir });
    const defaultList = runCli(['roles', 'list'], { dataDir });
    expect(defaultList.stdout).toMatch(/no roles match/i);
  });
});

describe('invoking cm from outside the project directory', () => {
  it('direct path invocation (node bin/cm.js) works regardless of cwd, unlike bare `npx cm`', () => {
    // Spawned with cwd = a temp dir *outside* the project, not runCli's
    // hardcoded project-root cwd — this is what makes the case meaningful:
    // `npx cm` only resolves our local package.json's bin field from inside
    // the project (verified separately, interactively — outside it, npx
    // instead tries to resolve "cm" as a registry package name and fails).
    // An absolute path has no such requirement.
    const result = spawnSync(process.execPath, [cliEntry, 'companies', 'list'], {
      cwd: os.tmpdir(),
      encoding: 'utf-8',
      env: { ...process.env, CM_DATA_DIR: dataDir },
    });

    expectNoRawCrash({ stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status });
    expect(result.status).toBe(0);
  });
});
