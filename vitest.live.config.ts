import { defineConfig } from 'vitest/config';

/**
 * The live suite: real `claude` calls against real services, run by hand
 * with `npm run test:live`. Slow (minutes), costs money, and depends on a
 * working `claude` login — which is exactly why it is not what `npm test`
 * runs.
 *
 * Deliberately serial: several of these drive a daemon through a chain of
 * live calls, and running them concurrently made ordinary latency variance
 * indistinguishable from a bug.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/helpers/global-setup.ts'],
    include: ['**/*.live.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 900_000,
    fileParallelism: false,
    env: {
      // Explicitly cleared, not merely unset. Whoever is working on the
      // offline fixture has CM_CLAUDE_BIN exported in their shell, and
      // inheriting it here would give a green `test:live` that never called
      // the model — the exact mirror of the bug test/offline-suite.test.ts
      // exists to prevent. The scripts' `${CM_CLAUDE_BIN:-claude}` treats
      // empty as absent, so this restores the real binary.
      CM_CLAUDE_BIN: '',
    },
  },
});
