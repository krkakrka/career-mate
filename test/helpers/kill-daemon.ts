import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from '../../src/lib/pid-file.js';

/**
 * Force-kills any daemon running against `dataDir` and waits for it to
 * actually die, for test cleanup. Deliberately SIGKILL, not SIGTERM:
 * graceful shutdown waits for in-flight work to finish, which for an
 * enrichment daemon can mean an entire chain of live claude -p calls
 * (structural -> research -> a newly-created company's own structural ->
 * its research/wlb) that the test stopped caring about once its own
 * assertions passed. There's no real data to protect — the whole temp
 * dataDir is about to be deleted anyway.
 */
export async function killDaemon(dataDir: string, timeoutMs = 5000): Promise<void> {
  const pidPath = path.join(dataDir, 'daemon.pid');
  let pid: number | undefined;
  try {
    const parsed = Number(fs.readFileSync(pidPath, 'utf-8').trim());
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    pid = undefined;
  }
  if (pid === undefined) return;

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return; // already gone.
  }

  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
