import type { Command } from 'commander';
import { getDb } from '../db/client.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current && current.parent; current = current.parent) names.push(current.name());
  return names.reverse().join(' ');
}

/** Instruments every Commander action centrally, so a new command cannot silently miss diagnostics. */
export function installCliOperationalLogging(program: Command): void {
  program.hook('preAction', (_parent, actionCommand) => {
    tryRecordOperationalLog(getDb(), {
      outcome: 'started', component: 'cli', action: commandPath(actionCommand),
    });
  });
  program.hook('postAction', (_parent, actionCommand) => {
    tryRecordOperationalLog(getDb(), {
      severity: process.exitCode && process.exitCode !== 0 ? 'error' : 'info',
      outcome: process.exitCode && process.exitCode !== 0 ? 'failed' : 'succeeded',
      component: 'cli', action: commandPath(actionCommand),
    });
  });
}
