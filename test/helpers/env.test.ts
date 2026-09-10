import { afterEach, describe, expect, it } from 'vitest';
import { restoreEnv } from './env.js';

const NAME = 'CM_TEST_RESTORE_ENV';

afterEach(() => {
  delete process.env[NAME];
});

describe('restoreEnv', () => {
  it('unsets a variable that was previously unset', () => {
    delete process.env[NAME];
    process.env[NAME] = '/tmp/something';

    restoreEnv(NAME, undefined);

    // The bug this exists to prevent: a plain assignment would leave the
    // literal string "undefined" here, not remove the variable.
    expect(NAME in process.env).toBe(false);
    expect(process.env[NAME]).toBeUndefined();
  });

  it('puts back a previous value', () => {
    restoreEnv(NAME, '/original');
    expect(process.env[NAME]).toBe('/original');
  });
});
