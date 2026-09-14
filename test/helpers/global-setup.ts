import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Kills every daemon a test run left behind.
 *
 * Daemons are spawned detached precisely so they outlive the command that
 * started them, which means an interrupted or failing test leaks one — and
 * it keeps polling a temp directory forever. Eleven such orphans were found
 * on the dev machine the first time this ran.
 *
 * A daemon's command line is just `node .../bin/cm-daemon.js`; which data
 * directory it serves is in its *environment*, which is why this reads
 * `ps eww` rather than matching the command. That distinction is the whole
 * safety property here: a daemon running against the project's real `.data`
 * must never be killed by a test run.
 */
/**
 * Records what the project's real `.data` holds before the suite runs, so
 * `teardown` can prove nothing wrote into it.
 *
 * CLAUDE.md requires every test touching `.data` to set `CM_DATA_DIR`, and
 * three suites had quietly stopped doing so — each because something they
 * called read a config file, and `loadJsonConfig` *creates* the file when
 * missing. The symptom is invisible: the suite passes, and the developer's
 * own settings file is silently created or consulted.
 */
const realDataDir = fileURLToPath(new URL('../../.data', import.meta.url));
let dataDirBefore: string[] = [];

export function setup(): void {
  dataDirBefore = listDataDir();
}

function listDataDir(): string[] {
  try {
    return fs.readdirSync(realDataDir).sort();
  } catch {
    return [];
  }
}

export function teardown(): void {
  const appeared = listDataDir().filter((entry) => !dataDirBefore.includes(entry));
  if (appeared.length > 0) {
    // Loud, not fatal: failing the run here would mask whatever the suite
    // was actually reporting, and the entry has already been created.
    console.warn(
      `[global-teardown] a test wrote into the project's real .data (${appeared.join(', ')}) — ` +
        'it is missing CM_DATA_DIR; see CLAUDE.md',
    );
  }

  const tempPrefix = normalize(os.tmpdir());

  let listing = '';
  try {
    listing = execSync('ps -eo pid=,command=', { encoding: 'utf-8' });
  } catch {
    return; // no ps, or not permitted — not worth failing a test run over
  }

  for (const line of listing.split('\n')) {
    if (!line.includes('cm-daemon')) continue;

    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!servesTempDataDir(pid, tempPrefix)) continue;

    try {
      process.kill(pid, 'SIGKILL');
      console.warn(`[global-teardown] killed leaked test daemon ${pid}`);
    } catch {
      // already gone
    }
  }
}

/**
 * macOS reports the temp dir as `/var/folders/...` to a child process but
 * `os.tmpdir()` resolves to `/private/var/folders/...`, so a raw prefix
 * comparison never matches and every leaked daemon survives. Collapsing the
 * `/private` alias is what makes the two comparable.
 */
function normalize(dir: string): string {
  return dir.replace(/^\/private(?=\/)/, '');
}



/** True only when the daemon's CM_DATA_DIR is under the OS temp dir — i.e. it belongs to a test, not to the user. */
function servesTempDataDir(pid: number, tempPrefix: string): boolean {
  let environment = '';
  try {
    environment = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf-8' });
  } catch {
    return false;
  }

  const match = /CM_DATA_DIR=(\S+)/.exec(environment);
  if (!match?.[1]) return false;

  // Anything without an explicit temp CM_DATA_DIR is left alone, including
  // a daemon with no override at all (which serves the real ./.data).
  const dataDir = normalize(match[1]);
  return dataDir.startsWith(tempPrefix) || dataDir.startsWith('/tmp/');
}
