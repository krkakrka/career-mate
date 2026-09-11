import { closeDb, getDb } from '../db/client.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
import { claimPidFile, removePidFile } from '../lib/daemon-pid.js';
import { buildHandlerRegistry, DEFAULT_TOPIC_CONCURRENCY } from './handlers/index.js';
import { startPolling } from './worker-pool.js';
import { killRunningExtractions } from '../enrichment/claude-extract.js';

const POLL_INTERVAL_MS = 500;

const db = getDb();

const claim = claimPidFile(process.pid);
if (!claim.claimed) {
  tryRecordOperationalLog(db, { severity: 'warn', outcome: 'skipped', component: 'daemon', action: 'start', context: { reason: 'already-running', existingPid: claim.existingPid } });
  console.log(`Another daemon is already running (pid ${claim.existingPid}); exiting.`);
  closeDb();
  process.exit(0);
}

tryRecordOperationalLog(db, { outcome: 'started', component: 'daemon', action: 'start', context: { pid: process.pid } });
const handlers = buildHandlerRegistry(db);
const handle = startPolling({ db, handlers, concurrency: DEFAULT_TOPIC_CONCURRENCY }, POLL_INTERVAL_MS);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  tryRecordOperationalLog(db, { outcome: 'started', component: 'daemon', action: 'shutdown' });
  handle
    .stop()
    .then(
      () => true,
      () => false, // best-effort — we're exiting either way, but this still decides what gets logged below.
    )
    .then((stoppedCleanly) => {
      // Before the pid file goes: an in-flight `claude` runs in its own
      // process group, so nothing else would ever kill it. Left behind it
      // keeps spending up to --max-budget-usd with no timeout watching it.
      killRunningExtractions();
      removePidFile();
      tryRecordOperationalLog(db, {
        severity: stoppedCleanly ? 'info' : 'warn',
        outcome: stoppedCleanly ? 'succeeded' : 'failed',
        component: 'daemon',
        action: 'shutdown',
      });
      closeDb();
      process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
