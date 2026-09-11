import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The default suite is offline, deterministic and free.
 *
 * `CM_CLAUDE_BIN` points every extraction script at a fake, so no test here
 * spends money, needs a `claude` login, or depends on what a model happens
 * to answer today. That is not only about cost: an intermittently failing
 * suite hides real bugs in its own noise, and one genuinely did.
 *
 * Tests that must exercise the real model live in `*.live.test.ts` and run
 * via `npm run test:live`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/helpers/global-setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
    testTimeout: 20_000,
    env: {
      CM_CLAUDE_BIN: fileURLToPath(new URL('./test/fixtures/fake-claude.py', import.meta.url)),
    },
  },
});
