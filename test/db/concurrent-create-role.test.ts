import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { createCompany } from '../../src/db/repositories/companies.js';

const workerScript = fileURLToPath(new URL('../fixtures/create-role-worker.mjs', import.meta.url));

interface WorkerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runWorker(dbPath: string, companyId: number, url: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, dbPath, String(companyId), url]);
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

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-concurrent-role-'));
  dbPath = path.join(tempDir, 'career-mate.db');
  const db = openDb(dbPath);
  createCompany(db, 'https://example.com');
  db.close();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('two processes racing to add the same role', () => {
  it('exactly one succeeds instead of both passing the duplicate check', async () => {
    const url = 'https://example.com/jobs/1';

    const [first, second] = await Promise.all([
      runWorker(dbPath, 1, url),
      runWorker(dbPath, 1, url),
    ]);

    const outcomes = [first, second];
    const succeeded = outcomes.filter((result) => result.exitCode === 0);
    const rejectedAsDuplicate = outcomes.filter(
      (result) => result.exitCode === 1 && /already tracks/.test(result.stderr),
    );

    expect(succeeded).toHaveLength(1);
    expect(rejectedAsDuplicate).toHaveLength(1);

    const db = openDb(dbPath);
    const count = db.prepare('SELECT COUNT(*) as count FROM roles').get() as { count: number };
    db.close();
    expect(count.count).toBe(1);
  });
});
