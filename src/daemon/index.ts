import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { loadSettings } from '../config/settings.js';
import { closeDb, getDb } from '../db/client.js';
import { requeueStaleRunningJobs } from '../db/repositories/jobs.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
import { killRunningExtractions } from '../enrichment/claude-extract.js';
import { DAEMON_READY_MESSAGE } from '../lib/daemon-control.js';
import { claimPidFile, removePidFile } from '../lib/daemon-pid.js';
import { dbPath } from '../lib/paths.js';
import { buildHandlerRegistry, DEFAULT_TOPIC_CONCURRENCY } from './handlers/index.js';
import { startPolling, type PollingHandle } from './worker-pool.js';
import { setProcessOrigin } from '../lib/origin.js';

// Jobs this process enqueues are caused by this surface; the worker
// overrides it per job so a chain keeps the origin that started it.
setProcessOrigin('daemon');

const POLL_INTERVAL_MS = 500;

// Assigned as startup progresses; `crash()` can run before either exists.
let db: Database.Database | undefined;
let handle: PollingHandle | undefined;

/**
 * A crash must leave a diagnosable record and no stale pid file.
 *
 * Without these, an uncaught exception kills the daemon silently: nothing
 * in `operational_logs` says why, and the pid file it leaves behind makes
 * `ensureDaemonRunning` believe a daemon is alive, so no new one starts and
 * every queued job simply stops being processed.
 *
 * Installed *before* startup runs, not after it — the first version
 * registered these at the bottom of the file, so a throw during startup
 * (a schema the migrations claimed to have applied but had not) skipped
 * them entirely: no log row, pid file left behind, and `cm daemon start`
 * reporting success over a process that was already dead.
 */
function crash(kind: string, error: unknown): void {
  // Installing these handlers suppresses Node's own "print the stack and
  // abort", and the operational log keeps only a sanitized 500-char
  // message — no stack. Printing here is what makes .data/daemon.log worth
  // having for a crash, which is the reason it exists.
  console.error(`[daemon] ${kind}:`, error);

  if (db) {
    tryRecordOperationalLog(db, {
      severity: 'error',
      outcome: 'failed',
      component: 'daemon',
      action: kind,
      error,
    });
  }
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

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Defensive: startup() is synchronous, so a signal cannot interleave it,
  // but keeping the closures honest about `db`/`handle` costs nothing.
  // There is nothing to stop, and the pid file is only ours if we claimed
  // it — removePidFile checks.
  if (!db || !handle) {
    removePidFile();
    closeDb();
    process.exit(0);
  }
  const database = db;
  tryRecordOperationalLog(database, { outcome: 'started', component: 'daemon', action: 'shutdown' });

  // Killed first, not after the stop: `stop()` waits for the in-flight
  // handler, and that handler is waiting on this very `claude` call. Doing
  // it afterwards meant there was never anything left to kill, and a
  // daemon that took the full 180s timeout to die would be `kill -9`ed by
  // an impatient user or supervisor — leaving the detached child alive and
  // still spending, which is exactly what this exists to prevent.
  killRunningExtractions();

  handle
    .stop()
    .then(
      () => true,
      () => false, // best-effort — we're exiting either way, but this still decides what gets logged below.
    )
    .then((stoppedCleanly) => {
      // The pid file is held until we are actually done. Releasing it at
      // the start of shutdown made `cm daemon status` report "not running"
      // for a daemon still working, left `cm daemon stop` with no pid to
      // signal, and — since `crash()` unlinks too — let a dying daemon
      // delete a *replacement* daemon's pid file. Shutdown is fast now
      // that stop() really stops, so the window this was meant to close is
      // one job at most.
      removePidFile();
      tryRecordOperationalLog(database, {
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

function startup(): void {
  db = getDb();

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
  const database = db;

  handle = startPolling({ db, handlers, concurrency: DEFAULT_TOPIC_CONCURRENCY }, POLL_INTERVAL_MS, {
    shouldStop: (workDone) => {
      if (Date.now() - lastStaleSweep >= STALE_JOB_SWEEP_MS) {
        lastStaleSweep = Date.now();
        requeueStaleRunningJobs(database, settings.stale_running_job_minutes);
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
      tryRecordOperationalLog(database, {
        outcome: 'succeeded',
        component: 'daemon',
        action: 'auto-exit',
        context: { reason },
      });
      shutdown();
    },
  });

  // Only now is "running" true. An explicit `cm daemon start` waits for
  // this; a daemon spawned by ensureDaemonRunning has no channel and
  // nobody waiting.
  //
  // The parent may already have gone — it timed out, or the user hit
  // Ctrl-C — and a send on a closed channel does not throw: Node emits
  // 'error' on `process` a tick later, which with no listener is an
  // uncaught exception, and crash() would then kill a daemon that had just
  // become healthy. The callback is what routes that error here instead;
  // the `connected` check alone still races the EOF.
  if (process.send && process.connected) {
    process.send(DAEMON_READY_MESSAGE, () => {
      // Delivered, or the parent was gone — either way it is not our concern.
    });
    // Unref (not close): nothing about the parent should hold this process
    // up or bring it down from here on.
    process.channel?.unref();
  }
}

try {
  startup();
} catch (error) {
  // Synchronous throws during startup never reach `uncaughtException` from
  // a module body in the same way, and this is the path that was silent.
  crash('startup', error);
}
