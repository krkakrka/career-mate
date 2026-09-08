import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { getJobById, type JobRecord } from '../../src/db/repositories/jobs.js';

const fixtureScript = fileURLToPath(
  new URL('../fixtures/enqueue-and-ensure-daemon.mjs', import.meta.url),
);

let dataDir: string;
let dbPath: string;

function runFixture(): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtureScript], {
      env: { ...process.env, CM_DATA_DIR: dataDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function waitForJobToSettle(jobId: number, timeoutMs = 8000): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = openDb(dbPath);
    const job = getJobById(db, jobId);
    db.close();
    if (job && (job.status === 'done' || job.status === 'failed')) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Job #${jobId} did not settle within ${timeoutMs}ms`);
}

function stopDaemonIfRunning(): void {
  const pidPath = path.join(dataDir, 'daemon.pid');
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone.
      }
    }
  } catch {
    // no pid file — nothing to stop.
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-daemon-autostart-'));
  dbPath = path.join(dataDir, 'career-mate.db');
});

afterEach(async () => {
  stopDaemonIfRunning();
  // give the daemon a moment to actually exit before removing its files out from under it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('daemon auto-start', () => {
  it(
    'a real detached daemon process claims and completes an enqueued job',
    async () => {
      const result = await runFixture();
      expect(result.exitCode).toBe(0);

      const match = result.stdout.match(/enqueued job #(\d+)/);
      expect(match).not.toBeNull();
      const jobId = Number(match![1]);

      const job = await waitForJobToSettle(jobId);
      expect(job.status).toBe('done');

      const pidPath = path.join(dataDir, 'daemon.pid');
      expect(fs.existsSync(pidPath)).toBe(true);
    },
    15000,
  );

  it(
    'ensureDaemonRunning is idempotent — a job enqueued while the daemon is already up still gets processed',
    async () => {
      const first = await runFixture();
      const firstJobId = Number(first.stdout.match(/enqueued job #(\d+)/)![1]);
      await waitForJobToSettle(firstJobId);

      const pidBefore = fs.readFileSync(path.join(dataDir, 'daemon.pid'), 'utf-8').trim();

      const second = await runFixture();
      const secondJobId = Number(second.stdout.match(/enqueued job #(\d+)/)![1]);
      const secondJob = await waitForJobToSettle(secondJobId);

      const pidAfter = fs.readFileSync(path.join(dataDir, 'daemon.pid'), 'utf-8').trim();

      expect(secondJob.status).toBe('done');
      expect(pidAfter).toBe(pidBefore);
    },
    15000,
  );
});
