// Standalone worker process for concurrency tests: opens (and migrates) the
// DB at the given path, then exits. Mirrors bin/cm.js's tsx-registration
// pattern so it can import the .ts source directly.
import { register } from 'tsx/esm/api';

register();

const { openDb } = await import('../../src/db/client.ts');

const dbPath = process.argv[2];
if (!dbPath) {
  throw new Error('usage: open-db-worker.mjs <path>');
}

const db = openDb(dbPath);
db.close();
