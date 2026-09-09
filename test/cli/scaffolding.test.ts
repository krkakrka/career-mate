import { describe, expect, it } from 'vitest';
import { runCli } from '../helpers/run-cli.js';

describe('cm --help', () => {
  it('exits 0', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
  });

  it('lists every top-level command group', () => {
    const result = runCli(['--help']);
    const expectedCommands = [
      'companies',
      'roles',
      'recruiters',
      'interview-note',
      'tips',
      'refresh',
      'discover',
      'status',
      'auth',
      'daemon',
      'worker',
      'events',
      'inbox',
    ];

    for (const command of expectedCommands) {
      expect(result.stdout).toContain(command);
    }
  });
});

describe('cm --version', () => {
  it('prints a version and exits 0', () => {
    const result = runCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
