import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cliEntry = fileURLToPath(new URL('../../bin/cm.js', import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Invokes the actual `cm` binary as a subprocess, the way a user would.
 * `dataDir`, when given, is passed via CM_DATA_DIR so each test runs against
 * an isolated, throwaway SQLite/file store instead of the developer's own ~/.data.
 */
export function runCli(args: string[], options: { dataDir?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: path.dirname(path.dirname(cliEntry)),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(options.dataDir ? { CM_DATA_DIR: options.dataDir } : {}),
    },
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
}
