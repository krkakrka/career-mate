import fs from 'node:fs';
import { loadSettings } from '../config/settings.js';
import { closeDb, getDb } from '../db/client.js';
import { requeueStaleRunningJobs } from '../db/repositories/jobs.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
import { killRunningExtractions } from '../enrichment/claude-extract.js';
import { claimPidFile, removePidFile } from '../lib/daemon-pid.js';
import { dbPath } from '../lib/paths.js';
import { buildHandlerRegistry, DEFAULT_TOPIC_CONCURRENCY } from './handlers/index.js';
import { startPolling } from './worker-pool.js';

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

const settings = loadSettings();

// Nothing else un-claims a job whose daemon died mid-run, so it would stay
// `running` forever — and `enqueueJobOnce` would keep deduping new requests
// against it.
//
// Swept periodically as well as at start, because start alone leaves a
// recovery gap: a daemon killed mid-job, followed by a `cm` command within
// the threshold, starts a daemon that skips the still-young row — and
// nothing would look again until some later restart happened to fall
// outside the window.
const STALE_JOB_SWEEP_MS = 5 * 60 * 1000;
let lastStaleSweep = Date.now();
requeueStaleRunningJobs(db, settings.stale_running_job_minutes);

const handlers = buildHandlerRegistry(db);
const databaseFile = dbPath();
const idleExitMs = settings.daemon_idle_exit_minutes * 60 * 1000;
let idleSince = Date.now();

const handle = startPolling({ db, handlers, concurrency: DEFAULT_TOPIC_CONCURRENCY }, POLL_INTERVAL_MS, {
  shouldStop: (workDone) => {
    if (Date.now() - lastStaleSweep >= STALE_JOB_SWEEP_MS) {
      lastStaleSweep = Date.now();
      requeueStaleRunningJobs(db, settings.stale_running_job_minutes);
    }

    // The data directory can be deleted out from under a running daemon
    // (a cleared .data, a finished test's temp dir). Everything it does
    // from then on writes to a file nobody will read, so it should go.
    if (!fs.existsSync(databaseFile)) return 'database file no longer exists';

    if (workDone > 0) {
      idleSince = Date.now();
      return undefined;
    }
    // Exiting when idle costs nothing: the next `cm` command starts a fresh
    // daemon, so no work is lost — and it is what stops a forgotten daemon
    // living for weeks. A configured 0 disables it (see settings.ts).
    if (idleExitMs > 0 && Date.now() - idleSince >= idleExitMs) return 'idle';
    return undefined;
  },
  onStopped: (reason) => {
    tryRecordOperationalLog(db, {
      outcome: 'succeeded',
      component: 'daemon',
      action: 'auto-exit',
      context: { reason },
    });
    shutdown();
  },
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  tryRecordOperationalLog(db, { outcome: 'started', component: 'daemon', action: 'shutdown' });

  // Released before the (awaited) stop, not after: while this daemon drains
  // its last tick, a concurrent `cm` command that enqueues a job would
  // otherwise see a live pid file, decline to spawn a replacement, and
  // leave that job pending with nobody to run it. A brief overlap of two
  // daemons is harmless — job claiming is a single atomic statement.
  removePidFile();

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

/**
 * A crash must leave a diagnosable record and no stale pid file.
 *
 * Without these, an uncaught exception kills the daemon silently: nothing
 * in `operational_logs` says why, and the pid file it leaves behind makes
 * `ensureDaemonRunning` believe a daemon is alive, so no new one starts and
 * every queued job simply stops being processed.
 */
function crash(kind: string, error: unknown): void {
  // Installing these handlers suppresses Node's own "print the stack and
  // abort", and the operational log keeps only a sanitized 500-char
  // message — no stack. Printing here is what makes .data/daemon.log worth
  // having for a crash, which is the reason it exists.
  console.error(`[daemon] ${kind}:`, error);

  tryRecordOperationalLog(db, {
    severity: 'error',
    outcome: 'failed',
    component: 'daemon',
    action: kind,
    error,
  });
  try {
    killRunningExtractions();
    removePidFile();
    closeDb();
  } catch {
    // already failing — never let cleanup mask the crash
  }
  process.exit(1);
}

process.on('uncaughtException', (error) => crash('uncaught-exception', error));
process.on('unhandledRejection', (reason) => crash('unhandled-rejection', reason));
