import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { listOperationalLogs } from '../../db/repositories/operational-logs.js';
import { daemonLogPath, startDaemon } from '../../lib/daemon-control.js';
import { isProcessAlive, readPidFile, removePidFile } from '../../lib/daemon-pid.js';

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command('daemon').description('Manage the background worker daemon');

  daemon
    .command('start')
    .description('Start the daemon and wait until it is confirmed running (idempotent — a no-op if already running)')
    .action(async () => {
      const result = await startDaemon();
      if (result.started) {
        console.log(`Daemon running (pid ${result.pid}).`);
        return;
      }
      if (result.reason === 'already-running') {
        console.log(`Daemon already running (pid ${result.pid}).`);
        return;
      }

      // The daemon died (or never confirmed) — say so, with what it printed.
      // "Daemon started." over a dead process was the behaviour this replaces.
      const what =
        result.reason === 'exited'
          ? `Daemon exited during startup (${result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode ?? 'unknown'}`}).`
          : 'Daemon did not confirm startup in time.';
      console.error(what);
      const output = result.output.trim();
      if (output) console.error(indent(output));
      console.error(`Log: ${daemonLogPath()} — durable record: cm logs --component daemon`);
      process.exitCode = 1;
    });

  daemon
    .command('status')
    .description('Show whether the daemon is running, and if not, how it last ended')
    .action(() => {
      const pid = readPidFile();
      if (pid !== undefined && isProcessAlive(pid)) {
        console.log(`Daemon running (pid ${pid}).`);
        return;
      }
      console.log('Daemon not running.');

      // "Not running" answers the question but not the one that follows —
      // did it exit cleanly, or is it crashing every time something starts
      // it? The last daemon record is the difference.
      const [last] = listOperationalLogs(getDb(), { component: 'daemon', limit: 1 });
      if (!last) return;
      console.log(`Last daemon event: ${last.occurred_at}  ${last.severity}/${last.outcome}  ${last.action}`);
      if (last.context) console.log(`  context: ${last.context}`);
      if (last.error) console.log(`  error: ${last.error}`);
      console.log(`Log: ${daemonLogPath()}`);
    });

  daemon
    .command('stop')
    .description('Stop the running daemon')
    .action(() => {
      const pid = readPidFile();
      if (pid === undefined || !isProcessAlive(pid)) {
        console.log('Daemon not running.');
        removePidFile();
        return;
      }
      process.kill(pid, 'SIGTERM');
      console.log(`Sent stop signal to daemon (pid ${pid}).`);
    });
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
