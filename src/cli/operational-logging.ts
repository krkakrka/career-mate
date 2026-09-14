import type { Command } from 'commander';
import { getDb } from '../db/client.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';

/**
 * The action currently in flight, for the top-level catch in index.ts.
 *
 * Commander skips its `postAction` hook when an action *rejects*, so the
 * hook never sees a failure — which meant the one class of run with no
 * timing was precisely the motivating case: a slow failure. A `cm refresh`
 * dying on a three-minute network timeout is exactly the thing worth
 * measuring, and it recorded nothing.
 */
let runningAction: { command: string; startedAt: number } | undefined;

export function takeRunningAction(): { command: string; durationMs: number } | undefined {
  if (!runningAction) return undefined;
  const { command, startedAt } = runningAction;
  runningAction = undefined;
  return { command, durationMs: Date.now() - startedAt };
}

/**
 * Commands that stay open until interrupted, and whose wall time therefore
 * measures how long you left a terminal open rather than how long any work
 * took.
 *
 * `cm logs --follow` blocks on a promise resolved only by SIGINT, and a
 * SIGINT handler suppresses default termination — so Commander's
 * postAction still runs and records the whole session. One hour-long watch
 * writes a 3,600,000 ms row that then occupies the top of a five-row
 * "slowest actions" list for a week, burying exactly the enrichment and
 * fetch timings the panel exists to surface.
 */
function isLongLivedInvocation(command: Command): boolean {
  return commandPath(command) === 'logs' && Boolean((command.opts() as { follow?: boolean }).follow);
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current && current.parent; current = current.parent) names.push(current.name());
  return names.reverse().join(' ');
}

/**
 * Instruments every Commander action centrally, so a new command cannot
 * silently miss diagnostics — and now times it.
 *
 * Keyed by the command object rather than a single variable: Commander can
 * run nested actions, and a shared `startedAt` would attribute the inner
 * command's duration to the outer one.
 */
export function installCliOperationalLogging(program: Command): void {
  const startedAt = new WeakMap<Command, number>();

  program.hook('preAction', (_parent, actionCommand) => {
    startedAt.set(actionCommand, Date.now());
    runningAction = { command: commandPath(actionCommand), startedAt: Date.now() };
    tryRecordOperationalLog(getDb(), {
      outcome: 'started', component: 'cli', action: commandPath(actionCommand),
    });
  });
  program.hook('postAction', (_parent, actionCommand) => {
    const began = startedAt.get(actionCommand);
    const failed = Boolean(process.exitCode && process.exitCode !== 0);
    tryRecordOperationalLog(getDb(), {
      severity: failed ? 'error' : 'info',
      outcome: failed ? 'failed' : 'succeeded',
      component: 'cli',
      action: commandPath(actionCommand),
      // A failed command's duration is as interesting as a successful
      // one's — often more so, since timeouts are slow failures.
      durationMs: began === undefined || isLongLivedInvocation(actionCommand) ? null : Date.now() - began,
    });
    runningAction = undefined;
  });
}
