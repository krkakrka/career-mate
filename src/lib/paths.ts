import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at src/lib/paths.ts, so two levels up is the project root.
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

export function getPackageRoot(): string {
  return packageRoot;
}

/**
 * Where career-mate keeps its SQLite DB, browser automation profile, and
 * downloaded reference files. Defaults to ./.data under the project root;
 * overridable via CM_DATA_DIR so tests (and, if ever needed, a user) can
 * point at an isolated location.
 */
export function getDataDir(): string {
  return process.env.CM_DATA_DIR ?? path.join(packageRoot, '.data');
}

/** The SQLite file inside the data dir. Single definition, so the daemon's "has my data dir been deleted?" check cannot drift from what getDb() actually opens. */
export function dbPath(): string {
  return path.join(getDataDir(), 'career-mate.db');
}
