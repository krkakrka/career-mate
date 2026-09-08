import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const workerScript = fileURLToPath(new URL('../fixtures/open-db-worker.mjs', import.meta.url));

interface WorkerResult {
  exitCode: number | null;
  stderr: string;
}

function runWorker(dbPath: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, dbPath]);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode, stderr }));
  });
}

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-concurrent-open-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('two processes opening a brand-new DB at the same time', () => {
  it('both succeed instead of one crashing on a migration race', async () => {
    // Reproduces the CLI-spawns-daemon startup pattern from PLAN.md: both
    // processes call openDb() against a fresh, not-yet-existing file at
    // roughly the same instant.
    const dbPath = path.join(tempDir, 'career-mate.db');

    const [first, second] = await Promise.all([runWorker(dbPath), runWorker(dbPath)]);

    for (const result of [first, second]) {
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });
});
