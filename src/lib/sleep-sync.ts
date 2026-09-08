/**
 * Blocks the current thread for `ms` milliseconds. better-sqlite3 is fully
 * synchronous, so retry/backoff loops around it (busy-retry, file locks)
 * have no event loop to yield to — this is the standard synchronous-sleep
 * trick for exactly that situation.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
