import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProcessAlive } from '../../src/lib/daemon-pid.js';

const daemonEntry = fileURLToPath(new URL('../../bin/cm-daemon.js', import.meta.url));

let dataDir: string;

function spawnDaemon(): ChildProcess {
  const child = spawn(process.execPath, [daemonEntry], {
    env: { ...process.env, CM_DATA_DIR: dataDir },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-daemon-race-'));
});

afterEach(async () => {
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
    // no pid file.
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('daemon single-instance enforcement', () => {
  it(
    'when two daemons are spawned at nearly the same instant, exactly one survives',
    async () => {
      const first = spawnDaemon();
      const second = spawnDaemon();

      // Give both a window to race for the pid-file claim and for the loser to exit.
      await new Promise((resolve) => setTimeout(resolve, 800));

      const pidPath = path.join(dataDir, 'daemon.pid');
      expect(fs.existsSync(pidPath)).toBe(true);
      const survivorPid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
      expect(isProcessAlive(survivorPid)).toBe(true);

      const candidatePids = [first.pid, second.pid].filter(
        (pid): pid is number => pid !== undefined,
      );
      const aliveCount = candidatePids.filter((pid) => isProcessAlive(pid)).length;
      expect(aliveCount).toBe(1);
      expect(candidatePids).toContain(survivorPid);
    },
    10000,
  );
});
