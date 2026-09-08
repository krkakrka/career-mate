import type { Command } from 'commander';
import { ensureDaemonRunning, isDaemonRunning } from '../../lib/daemon-control.js';
import { isProcessAlive, readPidFile, removePidFile } from '../../lib/daemon-pid.js';

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command('daemon').description('Manage the background worker daemon');

  daemon
    .command('start')
    .description('Start the daemon explicitly (idempotent — a no-op if already running)')
    .action(() => {
      if (isDaemonRunning()) {
        console.log(`Daemon already running (pid ${readPidFile()}).`);
        return;
      }
      ensureDaemonRunning();
      console.log('Daemon started.');
    });

  daemon
    .command('status')
    .description('Show whether the daemon is running')
    .action(() => {
      const pid = readPidFile();
      if (pid !== undefined && isProcessAlive(pid)) {
        console.log(`Daemon running (pid ${pid}).`);
      } else {
        console.log('Daemon not running.');
      }
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
