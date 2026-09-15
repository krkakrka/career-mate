import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The child process is stubbed, so these run identically on every platform
 * and draw no banners.
 *
 * The previous version called the real `osascript` and popped a real
 * notification on every `npm test` — the exact thing its own comment said
 * it was avoiding — and made the offline suite depend on whether
 * notification authorization happened to be granted.
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const { deliverMacosNotification } = await import('./macos.js');

/** Runs the callback with the given error, as `execFile` does. */
function respond(error: (Error & { code?: number; killed?: boolean }) | null): void {
  // The callback is taken from the end rather than by position, so the stub
  // does not depend on whether an options object was passed.
  execFileMock.mockImplementation((...args: unknown[]) => {
    // eslint-disable-next-line no-console
    (args[args.length - 1] as (e: unknown) => void)(error);
  });
}

const argsOf = (): string[] => execFileMock.mock.calls[0]![1] as string[];

// Only the call log is cleared, not the implementation: `argsOf` reads the
// first call, so a stale one from a previous `it.each` iteration would be
// asserted instead — but `mockReset` would also drop the stub `respond`
// installs, leaving `execFile` returning undefined.
beforeEach(() => {
  // A block body, deliberately: `mockClear()` returns the mock for
  // chaining, and Vitest treats a function returned from a hook as a
  // teardown callback — so an expression body made it *call the mock* with
  // no arguments after every test.
  execFileMock.mockClear();
});

describe('deliverMacosNotification', () => {
  it('passes every dynamic value after `--`, never inside the script', () => {
    // The script must be a fixed literal and the text must be argv. This is
    // the whole safety property: notification text carries role titles
    // scraped from web pages, and AppleScript can run shell commands.
    respond(null);
    const hostile = '" & (do shell script "touch /tmp/pwned") & "';

    return deliverMacosNotification(hostile, 'career-mate').then(() => {
      const args = argsOf();
      const separator = args.indexOf('--');

      expect(separator).toBeGreaterThan(0);
      // The text is after the separator...
      expect(args.slice(separator + 1)).toEqual([hostile, 'career-mate']);
      // ...and nowhere inside the script that precedes it.
      expect(args.slice(0, separator).join(' ')).not.toContain('do shell script');
      expect(execFileMock.mock.calls[0]![0]).toBe('/usr/bin/osascript');
    });
  });

  it.each([['-Senior Engineer (Remote)'], ['-e'], ['--help']])(
    'keeps %s out of osascript\'s option position',
    async (message) => {
      // Without `--`, a title beginning with a hyphen is rejected as an
      // illegal option and the banner is silently dropped; a message of
      // exactly `-e` is consumed as a second script flag, which makes the
      // *next* argument AppleScript source.
      respond(null);
      await deliverMacosNotification(message, 'career-mate');

      // Compared *after the separator*: `indexOf('-e')` on the whole array
      // finds the script flag at position 0, not the message — which is how
      // the first version of this test managed to fail against correct code.
      const args = argsOf();
      const afterSeparator = args.slice(args.indexOf('--') + 1);
      expect(afterSeparator[0]).toBe(message);
    },
  );

  it('reports a failure rather than throwing', async () => {
    // A banner is a nicety; the notification row is already written by the
    // time this runs, and losing a queue item because a banner could not be
    // drawn would trade the durable record for the ephemeral one.
    respond(Object.assign(new Error('Command failed: osascript'), { code: 1 }));

    await expect(deliverMacosNotification('hello')).resolves.toEqual({
      delivered: false,
      reason: 'osascript exited with 1',
    });
  });

  it('does not quote the notification text back into the failure reason', async () => {
    // `error.message` is "Command failed: /usr/bin/osascript -e <script>
    // <message> …", which would put page-derived content into durable
    // storage that `operational_logs`' sanitizer does not cover.
    respond(Object.assign(new Error('Command failed: osascript -e ... Staff Engineer at Acme'), { code: 1 }));

    const result = await deliverMacosNotification('Staff Engineer at Acme');
    expect(result.reason).not.toContain('Staff Engineer');
  });

  it('names a timeout as a timeout', async () => {
    respond(Object.assign(new Error('killed'), { killed: true }));
    await expect(deliverMacosNotification('hello')).resolves.toMatchObject({ reason: /timed out/ });
  });
});
