import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { enqueueJob, listJobs, requeueStaleRunningJobs } from '../../src/db/repositories/jobs.js';
import { listOperationalLogs } from '../../src/db/repositories/operational-logs.js';
import { isProcessAlive } from '../../src/lib/pid-file.js';
import { killDaemon } from '../helpers/kill-daemon.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-lifecycle-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(async () => {
  await killDaemon(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeSettings(settings: Record<string, unknown>): void {
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings));
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

const pidPath = (): string => path.join(dataDir, 'daemon.pid');

describe('stale running jobs', () => {
  it('requeues a job the previous daemon died holding', async () => {
    const db = openDb(dbPath);
    const job = enqueueJob(db, { topic: 'notification', payload: { kind: 'test' } });
    // Exactly the state a `kill -9` leaves behind: claimed, never released.
    db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      job.id,
    );
    db.close();

    runCli(['daemon', 'start'], { dataDir, allowDaemonAutostart: true });

    const requeued = await waitFor(() => {
      const check = openDb(dbPath);
      try {
        return listJobs(check).some((row) => row.id === job.id && row.status !== 'running');
      } finally {
        check.close();
      }
    });

    // Without this the job is stranded forever — and enqueueJobOnce keeps
    // deduping new requests against it, so the work never happens again.
    expect(requeued).toBe(true);

    const logs = openDb(dbPath);
    try {
      expect(listOperationalLogs(logs, { action: 'requeue-stale-job' }).length).toBeGreaterThan(0);
    } finally {
      logs.close();
    }
  }, 30_000);

  it('gives up on a job that keeps killing the daemon, instead of looping forever', async () => {
    const db = openDb(dbPath);
    const job = enqueueJob(db, { topic: 'notification', payload: { kind: 'test' } });
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    try {
      // A job that kills the daemon rather than throwing inside its handler
      // (an OOM on a huge page, a native crash, anything reaching
      // uncaughtException) never goes through failJob, so its retry cap is
      // never consulted. Requeued verbatim it would kill the next daemon
      // too — and idle-exit plus autostart would keep supplying victims.
      for (let restart = 0; restart < 5; restart += 1) {
        db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(stale, job.id);
        requeueStaleRunningJobs(db, 30);
      }

      const final = listJobs(db).find((row) => row.id === job.id)!;
      expect(final.status).toBe('failed');
      expect(final.error).toMatch(/without completing it/i);
    } finally {
      db.close();
    }
  });

  it('leaves a freshly claimed job alone', async () => {
    const db = openDb(dbPath);
    const job = enqueueJob(db, { topic: 'notification', payload: { kind: 'test' } });
    db.prepare("UPDATE jobs SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(job.id);
    db.close();

    // A job claimed seconds ago belongs to a live daemon; requeueing it
    // would run the same work twice.
    const check = openDb(dbPath);
    try {
      expect(requeueStaleRunningJobs(check, 30)).toBe(0);
    } finally {
      check.close();
    }
  });
});

describe('daemon self-exit', () => {
  it('exits when its data directory is deleted out from under it', async () => {
    writeSettings({ daemon_idle_exit_minutes: 0 });
    runCli(['daemon', 'start'], { dataDir, allowDaemonAutostart: true });
    expect(await waitFor(() => fs.existsSync(pidPath()))).toBe(true);
    const pid = Number(fs.readFileSync(pidPath(), 'utf-8').trim());

    fs.rmSync(dbPath, { force: true });

    // Everything it does from here writes to a file nobody will read.
    const exited = await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(exited).toBe(true);
  }, 30_000);

  it('exits after the configured idle window, leaving no pid file behind', async () => {
    // A minute is the smallest non-zero window; the daemon has nothing to
    // do here, so it should go almost immediately.
    writeSettings({ daemon_idle_exit_minutes: 0.001 });

    runCli(['daemon', 'start'], { dataDir, allowDaemonAutostart: true });

    // Exiting when idle loses nothing: the next `cm` command starts a fresh
    // daemon, and this is what stops a forgotten one living for weeks.
    expect(await waitFor(() => !fs.existsSync(pidPath()))).toBe(true);
  }, 30_000);
});

describe('crash handling', () => {
  it('logs an uncaught non-Error, removes the pid file, and exits non-zero', async () => {
    const crashEntry = fileURLToPath(new URL('../fixtures/crash-daemon.mjs', import.meta.url));

    const result = spawnSync(process.execPath, [crashEntry], {
      encoding: 'utf-8',
      env: { ...process.env, CM_DATA_DIR: dataDir },
      timeout: 30_000,
    });

    // Silently dying was the old behaviour: nothing said why, and the
    // stale pid file made ensureDaemonRunning believe a daemon was alive,
    // so no new one started and every queued job stopped being processed.
    expect(result.status).toBe(1);
    expect(fs.existsSync(pidPath())).toBe(false);

    const db = openDb(dbPath);
    try {
      const crashes = listOperationalLogs(db, { action: 'uncaught-exception' });
      expect(crashes).toHaveLength(1);
      expect(crashes[0]!.severity).toBe('error');
      expect(crashes[0]!.error).toContain('daemon exploded');
    } finally {
      db.close();
    }
  }, 40_000);
});

describe('explicit start', () => {
  it('reports a daemon that dies during startup, with why, instead of "Daemon started."', async () => {
    // Exactly the state a migration file edited after it was applied leaves
    // behind: `_migrations` says 0008 ran, the column it now adds is missing,
    // and the runner will never look at it again.
    const db = openDb(dbPath);
    db.exec('ALTER TABLE jobs DROP COLUMN claimed_at');
    db.close();

    const result = runCli(['daemon', 'start'], { dataDir, allowDaemonAutostart: true });

    // The old command spawned and returned "Daemon started." with exit 0
    // while the child was already dead — the failure was only findable by
    // knowing to open .data/daemon.log.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('claimed_at');
    expect(result.stderr).toContain('daemon.log');
    expect(result.stdout).not.toContain('Daemon started');
    expect(fs.existsSync(pidPath())).toBe(false);

    // The crash happened before the daemon reached its job loop — before
    // the old code installed its crash handlers — so nothing durable said
    // why. `cm logs` must have the answer now.
    const logs = openDb(dbPath);
    try {
      const failures = listOperationalLogs(logs, { component: 'daemon', severity: 'error' });
      expect(failures).toHaveLength(1);
      expect(failures[0]!.action).toBe('startup');
      expect(failures[0]!.error).toContain('claimed_at');
    } finally {
      logs.close();
    }

    // And `status` — the command the user actually reaches for — says so too.
    const status = runCli(['daemon', 'status'], { dataDir });
    expect(status.stdout).toContain('Daemon not running');
    expect(status.stdout).toContain('startup');
    expect(status.stdout).toContain('claimed_at');
    expect(status.stdout).toContain('daemon.log');
  }, 40_000);

  it('confirms a live pid on success and is idempotent', async () => {
    writeSettings({ daemon_idle_exit_minutes: 0 });

    const first = runCli(['daemon', 'start'], { dataDir, allowDaemonAutostart: true });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/Daemon running \(pid \d+\)/);
    const pid = Number(fs.readFileSync(pidPath(), 'utf-8').trim());
    expect(first.stdout).toContain(`pid ${pid}`);

    const second = runCli(['daemon', 'start'], { dataDir, allowDaemonAutostart: true });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(`already running (pid ${pid})`);

    const status = runCli(['daemon', 'status'], { dataDir });
    expect(status.stdout).toContain(`Daemon running (pid ${pid})`);
  }, 40_000);

  it('status on a daemon that stopped cleanly says so, not just "not running"', async () => {
    writeSettings({ daemon_idle_exit_minutes: 0.001 });
    runCli(['daemon', 'start'], { dataDir, allowDaemonAutostart: true });
    expect(await waitFor(() => !fs.existsSync(pidPath()))).toBe(true);

    const status = runCli(['daemon', 'status'], { dataDir });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('Daemon not running');
    expect(status.stdout).toMatch(/shutdown/);
  }, 40_000);

  it('survives its starter going away before it was ready', async () => {
    writeSettings({ daemon_idle_exit_minutes: 0 });
    const daemonEntry = fileURLToPath(new URL('../../bin/cm-daemon.js', import.meta.url));

    // What `cm daemon start` timing out, or a Ctrl-C on it, looks like from
    // the daemon's side: an IPC channel that is gone by the time `ready`
    // is sent. A send on a closed channel surfaces as an 'error' on
    // `process` a tick later — uncaught, that reaches crash() and kills a
    // daemon that had just become healthy.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [daemonEntry], {
      env: { ...process.env, CM_DATA_DIR: dataDir },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.unref();
    child.disconnect();

    expect(await waitFor(() => fs.existsSync(pidPath()))).toBe(true);
    const pid = Number(fs.readFileSync(pidPath(), 'utf-8').trim());
    expect(pid).toBe(child.pid);

    // Long enough for startup to finish and the doomed send to be processed.
    const died = await waitFor(() => !isProcessAlive(pid), 2500);
    expect(died).toBe(false);

    const db = openDb(dbPath);
    try {
      expect(listOperationalLogs(db, { component: 'daemon', severity: 'error' })).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 40_000);

  it('status with no history stays terse', () => {
    const status = runCli(['daemon', 'status'], { dataDir });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.trim()).toBe('Daemon not running.');
  });
});

describe('daemon log', () => {
  it('captures daemon output instead of discarding it', async () => {
    runCli(['companies', 'add', 'http://127.0.0.1:1/co'], { dataDir, allowDaemonAutostart: true });

    // The daemon is where terminal notifications print and where a crash
    // prints its stack; /dev/null made "it did nothing and I don't know
    // why" unanswerable.
    expect(await waitFor(() => fs.existsSync(path.join(dataDir, 'daemon.log')))).toBe(true);
  }, 30_000);
});
