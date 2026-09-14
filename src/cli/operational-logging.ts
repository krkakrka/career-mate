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
let runningAction: { command: string; startedAt: number; timed: boolean } | undefined;

export function takeRunningAction(): { command: string; durationMs: number | null; startupMs: number | null } | undefined {
  if (!runningAction) return undefined;
  const { command, startedAt, timed } = runningAction;
  runningAction = undefined;
  return {
    command,
    durationMs: timed ? Date.now() - startedAt : null,
    // Reported on the crash path too. Without it the startup median is
    // computed over successes only, and in a window where the CLI only ever
    // crashed — a malformed preferences.json, a locked database — the one
    // number this measurement turns on would silently vanish from `cm
    // status`.
    startupMs: startupCostMs(startedAt),
  };
}

/**
 * Commands whose wall time is not the cost of one interaction, and which
 * therefore must not be timed as one.
 *
 * Two different distortions, same remedy:
 *
 * - **`cm logs --follow`** blocks on a promise resolved only by SIGINT, and
 *   a SIGINT handler suppresses default termination — so Commander's
 *   postAction still runs and records the whole session. One hour-long
 *   watch writes a 3,600,000 ms row that then occupies the top of a
 *   five-row "slowest actions" list for a week, burying exactly the
 *   enrichment and fetch timings the panel exists to surface.
 *
 * - **`cm worker drain`** runs the worker pool in-process, so its duration
 *   covers every enrichment job it happened to pick up — model calls
 *   included. Timed as a CLI action it attributes the *daemon's* work to
 *   the CLI surface, and since every MCP tool merely enqueues and returns,
 *   `cm status` would report the CLI as minutes-slow against an agent that
 *   looks instant. That inverts the exact comparison Step 26 exists to
 *   make.
 */
function isLongLivedInvocation(command: Command): boolean {
  const name = commandPath(command);
  if (name === 'worker drain') return true;
  return name === 'logs' && Boolean((command.opts() as { follow?: boolean }).follow);
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

/**
 * Everything that happened before the action did: Node bootstrap, tsx
 * registering its ESM loader, module evaluation, Commander parsing.
 *
 * Recorded because leaving it out made the CLI look ~65x cheaper than it
 * is. `cm roles list` reports 5 ms of work while taking 340 ms of a
 * person's time, and the MCP server — a long-lived process that pays this
 * once — answers the same request in about 1 ms. Comparing only in-process
 * durations would have concluded the two surfaces were near-identical,
 * which is the opposite of what the numbers say.
 *
 * `process.uptime()` covers the whole process, unlike any timer this module
 * could start: by the time this file is even imported, most of the cost has
 * already been paid.
 */
export function startupCostMs(began: number | undefined): number | null {
  if (began === undefined) return null;
  const sinceProcessStart = process.uptime() * 1000;
  const sinceActionStart = Date.now() - began;
  return Math.max(0, Math.round(sinceProcessStart - sinceActionStart));
}

export function installCliOperationalLogging(program: Command): void {
  const startedAt = new WeakMap<Command, number>();

  program.hook('preAction', (_parent, actionCommand) => {
    startedAt.set(actionCommand, Date.now());
    // `timed: false` for a watch command, so the exclusion holds on the
    // rejection path too — otherwise a `cm logs --follow` that dies with a
    // DB error records the whole session, which is exactly the multi-hour
    // row this suppression exists to keep out of the slowest-actions panel.
    runningAction = {
      command: commandPath(actionCommand),
      startedAt: Date.now(),
      timed: !isLongLivedInvocation(actionCommand),
    };
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
      context: { startupMs: startupCostMs(began) },
    });
    runningAction = undefined;
  });
}
