import { describe, expect, it } from 'vitest';

/**
 * The inverse of test/offline-suite.test.ts.
 *
 * Anyone working on the offline fixture has CM_CLAUDE_BIN exported in their
 * shell. If the live config inherited it, `npm run test:live` would go green
 * without ever calling the model — which is worse than it failing, because
 * the whole point of this suite is that it is the one thing checking the
 * real integration still works.
 */
describe('the live suite really is live', () => {
  it('does not run against the offline fake', () => {
    expect(process.env.CM_CLAUDE_BIN ?? '').toBe('');
  });
});
