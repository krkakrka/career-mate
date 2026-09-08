import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cliEntry = fileURLToPath(new URL('../../bin/cm.js', import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunCliOptions {
  /** Passed via CM_DATA_DIR so each test runs against an isolated, throwaway SQLite/file store instead of the developer's own .data. */
  dataDir?: string;
  /**
   * Commands that enqueue a job (roles/companies add, rerun-enrichment)
   * call ensureDaemonRunning(), which — by default here — is disabled via
   * CM_DISABLE_DAEMON_AUTOSTART, so ordinary CLI tests don't spawn a real
   * daemon that hits the real network and real claude -p. Set this to
   * `true` only in tests that specifically want to exercise the real
   * daemon/enrichment flow.
   */
  allowDaemonAutostart?: boolean;
}

/**
 * Invokes the actual `cm` binary as a subprocess, the way a user would.
 */
export function runCli(args: string[], options: RunCliOptions = {}): CliResult {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: path.dirname(path.dirname(cliEntry)),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(options.dataDir ? { CM_DATA_DIR: options.dataDir } : {}),
      ...(options.allowDaemonAutostart ? {} : { CM_DISABLE_DAEMON_AUTOSTART: '1' }),
    },
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
}
