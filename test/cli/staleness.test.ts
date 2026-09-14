import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { listJobs } from '../../src/db/repositories/jobs.js';
import { killDaemon } from '../helpers/kill-daemon.js';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-staleness-'));
});

afterEach(async () => {
  // `add` autostarts a daemon; without this it would keep working through
  // enrichment jobs against a directory the next line deletes.
  await killDaemon(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Enrichment jobs still waiting or in flight. Counting *these* rather than
 * all rows is what makes the assertion independent of whether the
 * background daemon happened to finish one mid-test — and live jobs are
 * exactly what the debounce is defined over.
 */
function liveEnrichmentJobs(): number {
  const db = openDb(path.join(dataDir, 'career-mate.db'));
  try {
    return listJobs(db, { limit: 1000 }).filter(
      (job) => job.topic === 'enrichment' && (job.status === 'pending' || job.status === 'running'),
    ).length;
  } finally {
    db.close();
  }
}

/** The daemon writes its pid file after it is spawned, so its appearance has to be waited for, not sampled once. */
async function pidFileAppears(timeoutMs = 10_000): Promise<boolean> {
  const pidPath = path.join(dataDir, 'daemon.pid');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe('cm show — lazy recompute', () => {
  it('marks a not-yet-computed field group as pending', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });

    const shown = runCli(['companies', 'show', '1'], { dataDir });

    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toMatch(/\(pending\)/);
  });

  it('never lets repeated reads pile up more than one live job per field group', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });

    for (let read = 0; read < 5; read += 1) {
      runCli(['companies', 'show', '1'], { dataDir });
      // A company has two checked groups (structural, research). Reading
      // triggers recomputes, so without the debounce this would climb by
      // two per read.
      expect(liveEnrichmentJobs()).toBeLessThanOrEqual(2);
    }
  });

  it('starts a daemon for the recomputes a read queues, so stale data can actually heal', async () => {
    // Port 1 has nothing listening, so the enrichment job the daemon picks
    // up fails immediately on connect — this exercises the daemon kick
    // without any fetch or model call.
    runCli(['companies', 'add', 'http://127.0.0.1:1/co'], { dataDir, allowDaemonAutostart: true });
    await killDaemon(dataDir);
    fs.rmSync(path.join(dataDir, 'daemon.pid'), { force: true });

    runCli(['companies', 'show', '1'], { dataDir, allowDaemonAutostart: true });

    // Without the kick the job sits pending forever — and because the
    // debounce then matches that same pending row, every later read queues
    // nothing and the entity prints (stale) for good. No daemon running is
    // the normal state after a reboot.
    expect(await pidFileAppears()).toBe(true);
  }, 20_000);

  it('lists without crashing when nothing has been derived yet', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });
    runCli(['roles', 'add', 'https://example.com/jobs/1', '--company', '1'], { dataDir });

    expect(runCli(['companies', 'list'], { dataDir }).exitCode).toBe(0);
    expect(runCli(['roles', 'list'], { dataDir }).exitCode).toBe(0);
    expect(runCli(['roles', 'show', '1'], { dataDir }).exitCode).toBe(0);
  });
});

describe('cm — action timing', () => {
  it('records how long a command took, and shows it in cm logs', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });

    const logs = runCli(['logs', '--component', 'cli', '--limit', '20'], { dataDir });

    // Every other question in this phase — is the agent path faster than
    // the CLI, is the browser the slow part — needs this number to exist.
    expect(logs.stdout).toMatch(/cli\.companies add\s+\d+(ms|\.\ds|m\d+s)/);
  });

  it('shows where the time goes in cm status', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });

    const status = runCli(['status'], { dataDir });

    expect(status.stdout).toMatch(/Slowest actions \(7d\):/);
    expect(status.stdout).toMatch(/cli\.companies add/);
  });
});

describe('cm status — model spend', () => {
  it('reports zero spend before anything has run', () => {
    const status = runCli(['status'], { dataDir });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(/Model spend: \$0\.00 over 0 call\(s\) in 7d/);
  });
});

describe('rerun-enrichment', () => {
  it('still works but points at the command that replaces it', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });

    const rerun = runCli(['companies', 'rerun-enrichment', '1'], { dataDir });

    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toMatch(/deprecated/i);
    expect(rerun.stdout).toMatch(/--force/);
  });
});
