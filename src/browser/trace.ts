/**
 * Where a Playwright trace goes, and how many are kept.
 *
 * A failed authenticated fetch is otherwise unanalysable: the exception
 * says "Timeout 20000ms exceeded" and nothing about what the page actually
 * did — whether the session cookie was sent, whether a login wall appeared,
 * whether the request left at all. A trace answers all three, and
 * `npx playwright show-trace <file>` replays it frame by frame.
 *
 * Kept deliberately small and browser-free so the naming and retention
 * rules are testable without launching Chromium.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../lib/paths.js';

/**
 * When to write a trace.
 *
 * `on-failure` is the default: traces are megabytes each, and the run you
 * want one for is the run that broke.
 */
export type TraceMode = 'never' | 'on-failure' | 'always';

export const TRACE_MODES: readonly TraceMode[] = ['never', 'on-failure', 'always'];

export function tracesDir(): string {
  return path.join(getDataDir(), 'traces');
}

/** A filename-safe stand-in for the label: a URL's host where it is one, otherwise the text itself. */
function slug(label: string): string {
  let text = label;
  try {
    text = new URL(label).hostname || label;
  } catch {
    // Not a URL — a hand-passed label like 'login-browser'.
  }
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'trace';
}

/**
 * A path no trace currently occupies, named for when and what.
 *
 * Sorting by name therefore sorts by time, which is what makes "the trace
 * from the run that just failed" findable in a directory listing.
 *
 * The existence check is belt-and-braces: every browser call goes through
 * the profile lock, so two traces cannot be in flight at once. It stays
 * because a silent overwrite would destroy the one piece of evidence this
 * whole mechanism exists to keep.
 */
export function allocateTracePath(label: string, now: Date = new Date()): string {
  // `:` is legal on macOS/Linux but not on Windows, and it is the character
  // Finder still renders as `/`. Swapped for `-` so the name survives being
  // copied anywhere.
  const stamp = now.toISOString().replace(/:/g, '-');
  const base = path.join(tracesDir(), `${stamp}-${slug(label)}`);

  let candidate = `${base}.zip`;
  for (let n = 1; fs.existsSync(candidate); n += 1) candidate = `${base}-${n}.zip`;
  return candidate;
}

/**
 * Deletes all but the `keep` newest traces, returning how many went.
 *
 * Nothing else ever removes them and each is megabytes, so without this,
 * turning tracing on is an unbounded disk leak in the same directory that
 * holds the database. Only `.zip` files are considered: the directory is
 * the user's to poke around in, and deleting an unrelated file someone
 * dropped there would be a surprise.
 *
 * `protect` is never deleted however low `keep` is. The caller prunes in a
 * `finally`, right after being handed the path it is about to print — so
 * without this, a low `keep` made `cm auth check` report
 * `npx playwright show-trace <file>` for a file deleted milliseconds
 * earlier.
 */
export function pruneTraces(keep: number, protect?: string): number {
  const dir = tracesDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.zip'));
  } catch {
    return 0; // No traces have ever been written.
  }

  const byNewest = names
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return undefined; // Vanished between readdir and stat.
      }
    })
    .filter((entry): entry is { file: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let deleted = 0;
  for (const entry of byNewest.slice(Math.max(0, keep))) {
    if (protect !== undefined && path.resolve(entry.file) === path.resolve(protect)) continue;
    try {
      fs.rmSync(entry.file);
      deleted += 1;
    } catch {
      // Held open or already gone — pruning is best effort, never fatal to the fetch it follows.
    }
  }
  return deleted;
}
