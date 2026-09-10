/**
 * Puts an environment variable back the way it was.
 *
 * `process.env.X = undefined` does NOT unset X — Node stringifies the
 * assignment, leaving the literal string "undefined". For CM_DATA_DIR that
 * makes `getDataDir()` return the relative path "undefined", so anything
 * running later in the same process writes ./undefined/... into the repo,
 * which is exactly what saving and restoring the variable was meant to
 * prevent.
 */
export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
