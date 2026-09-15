import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliverMacosNotification } from '../../src/notify/macos.js';

/**
 * Live because it draws a real banner on the machine running it.
 *
 * Kept out of `npm test` for the same reason the model-calling tests are:
 * the offline suite must have no visible side effects on the developer's
 * screen. `src/notify/macos.test.ts` covers the argument construction with
 * the child process stubbed; this is where the claim is checked against
 * the real interpreter.
 */
describe.runIf(process.platform === 'darwin')('deliverMacosNotification (live)', () => {
  it('does not execute AppleScript hidden in the notification text', async () => {
    // A sentinel, not an exit code. `delivered: true` is satisfied by a
    // *successful injection*: built the naive concatenating version and it
    // ran the shell command and exited 0. Only the file's absence
    // distinguishes "passed through as text" from "executed".
    const sentinel = path.join(os.tmpdir(), `career-mate-injection-${process.pid}`);
    fs.rmSync(sentinel, { force: true });

    const result = await deliverMacosNotification(
      `" & (do shell script "touch ${sentinel}") & "`,
      'career-mate test',
    );

    expect(result).toEqual({ delivered: true });
    expect(fs.existsSync(sentinel), 'the notification text was executed as AppleScript').toBe(false);
  });

  it('delivers a title that starts with a hyphen', async () => {
    // Without `--`, this is rejected as an illegal option and the banner is
    // silently dropped. Role titles come from a model reading a posting; a
    // leading hyphen is ordinary.
    await expect(deliverMacosNotification('-Senior Engineer (Remote)', 'career-mate test')).resolves.toEqual({
      delivered: true,
    });
  });
});
