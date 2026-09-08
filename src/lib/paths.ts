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
