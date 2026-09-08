import { closeDb, getDb } from '../db/client.js';
import { claimPidFile, removePidFile } from '../lib/daemon-pid.js';
import { buildHandlerRegistry, DEFAULT_TOPIC_CONCURRENCY } from './handlers/index.js';
import { startPolling } from './worker-pool.js';

const POLL_INTERVAL_MS = 500;

const db = getDb();

const claim = claimPidFile(process.pid);
if (!claim.claimed) {
  console.log(`Another daemon is already running (pid ${claim.existingPid}); exiting.`);
  closeDb();
  process.exit(0);
}

const handlers = buildHandlerRegistry(db);
const handle = startPolling({ db, handlers, concurrency: DEFAULT_TOPIC_CONCURRENCY }, POLL_INTERVAL_MS);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  handle
    .stop()
    .catch(() => {
      // best-effort — we're exiting either way.
    })
    .finally(() => {
      removePidFile();
      closeDb();
      process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
