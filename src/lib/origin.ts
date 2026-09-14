/**
 * Which surface caused the work currently being done.
 *
 * Step 26 asks whether the agent is actually better than the CLI and what
 * it costs. Durations were already answerable — every CLI action and every
 * MCP tool call lands in `operational_logs` with a `component` — but *money*
 * was not: the daemon spends it, on a queue both surfaces feed, and nothing
 * recorded who filled the queue. Grouping `model_calls` by the daemon that
 * made them answers "what did enrichment cost", never "what did asking the
 * agent cost".
 *
 * So a job carries the surface that caused it, and a job enqueued *while
 * handling* another job inherits its origin — otherwise a `role-structural`
 * asked for from the agent would attribute its own cost to `mcp` and the
 * `role-research` it chains into to `daemon`, splitting one request's bill
 * across two surfaces and under-reporting the expensive half.
 *
 * `AsyncLocalStorage` rather than a module-level variable, because the
 * worker pool runs several `drainSlot` loops concurrently through
 * `Promise.all`: a plain global set around `await handler(job)` would be
 * overwritten by whichever slot happened to interleave, and every
 * measurement this step produces would be quietly wrong.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type Origin = 'cli' | 'mcp' | 'daemon';

export const ORIGINS: readonly Origin[] = ['cli', 'mcp', 'daemon'];

const storage = new AsyncLocalStorage<Origin>();

/**
 * The process's own surface, for work not running inside a job.
 *
 * Defaults to `cli` because that is what an unmarked entry point is — the
 * binary a person ran. `bin/cm-mcp.js` and `bin/cm-daemon.js` say otherwise
 * at startup.
 */
let processOrigin: Origin = 'cli';

export function setProcessOrigin(origin: Origin): void {
  processOrigin = origin;
}

export function getOrigin(): Origin {
  return storage.getStore() ?? processOrigin;
}

/** Runs `fn` with `origin` in effect, including for anything it awaits. */
export function withOrigin<T>(origin: Origin, fn: () => T): T {
  return storage.run(origin, fn);
}

/** Narrows a value read back from the database, where an older row may hold anything or nothing. */
export function toOrigin(value: unknown): Origin | undefined {
  return typeof value === 'string' && (ORIGINS as readonly string[]).includes(value) ? (value as Origin) : undefined;
}
