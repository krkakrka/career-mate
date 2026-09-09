import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLockAsync } from './file-lock.js';

let tempDir: string;
let lockPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-file-lock-'));
  lockPath = path.join(tempDir, 'test.lock');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('acquireLockAsync', () => {
  it('claims an uncontended lock immediately', async () => {
    await expect(acquireLockAsync(lockPath, 1000)).resolves.toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('times out (does not hang forever) when the lock is held by another live process', async () => {
    fs.writeFileSync(lockPath, String(process.pid)); // this process is alive, so this is a genuine (not stale) hold

    await expect(acquireLockAsync(lockPath, 300, 20)).rejects.toThrow(/Timed out/);
  });

  it(
    'does NOT block the event loop while waiting — other async work keeps making progress',
    async () => {
      fs.writeFileSync(lockPath, String(process.pid)); // held for the whole wait, forcing acquireLockAsync to poll

      let tickCount = 0;
      const ticker = setInterval(() => {
        tickCount += 1;
      }, 10);

      try {
        await expect(acquireLockAsync(lockPath, 300, 20)).rejects.toThrow(/Timed out/);
      } finally {
        clearInterval(ticker);
      }

      // If acquireLockAsync were blocking the thread (e.g. via a
      // synchronous Atomics.wait busy-loop, which is exactly what the old
      // sync acquireLock does and why this async variant exists), the
      // interval above would never have fired during the ~300ms wait.
      expect(tickCount).toBeGreaterThan(5);
    },
    2000,
  );
});
