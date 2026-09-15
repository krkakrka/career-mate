/**
 * macOS banner delivery for the `macos` notification channel.
 *
 * **The text is never interpolated into AppleScript source.** Notification
 * messages carry role and company titles, which came from a fetched web
 * page by way of the model — untrusted input by the same rule CLAUDE.md
 * states for `claude` calls. AppleScript can run shell commands
 * (`do shell script`), so building the script by concatenation would be a
 * code-execution path, not a formatting bug.
 *
 * Instead the script is a fixed string with an `on run argv` handler and
 * the text goes through `execFile`'s argument array — no shell, no
 * interpolation, at either level.
 *
 * `--` is what makes that true, and it is not decoration. Without it the
 * message sits in osascript's *option* position: a role title beginning
 * with a hyphen (`-Senior Engineer (Remote)`) is rejected as an illegal
 * option and the banner is silently dropped, and a message of exactly `-e`
 * is consumed as a second script flag — which makes the *next* argument
 * AppleScript source. Harmless only while the title is a fixed literal;
 * the separator is what keeps it harmless if it ever stops being.
 */

import { execFile } from 'node:child_process';

/** Fixed, and must stay fixed: every dynamic value arrives as an argument. */
const SCRIPT = `on run argv
  display notification (item 1 of argv) with title (item 2 of argv)
end run`;

/** A banner is a nicety; nothing may wait on one. */
const TIMEOUT_MS = 5_000;

/** Enough to act on, without quoting the notification text back into the log. */
function describeFailure(error: Error & { code?: string | number; killed?: boolean }): string {
  if (error.killed) return `osascript timed out after ${TIMEOUT_MS / 1000}s`;
  if (error.code !== undefined) return `osascript exited with ${error.code}`;
  return 'osascript failed';
}

export interface MacosNotifyResult {
  delivered: boolean;
  /** Why not, when it was not — for the operational log, never thrown. */
  reason?: string;
}

/**
 * Shows a banner, reporting rather than throwing.
 *
 * Delivery failure must never fail the job: the notification row is already
 * written by the time this runs, and losing a queue item because a banner
 * could not be drawn would trade the durable record for the ephemeral one.
 */
export async function deliverMacosNotification(message: string, title = 'career-mate'): Promise<MacosNotifyResult> {
  if (process.platform !== 'darwin') {
    return { delivered: false, reason: `not macOS (${process.platform})` };
  }

  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      // `--` ends option parsing: everything after it is argv, whatever it
      // starts with.
      ['-e', SCRIPT, '--', message, title],
      { timeout: TIMEOUT_MS },
      (error) => {
        // `error.message` is "Command failed: /usr/bin/osascript -e <script>
        // <message> …", which embeds page-derived text into durable
        // storage. The code and exit status say what went wrong without
        // carrying the posting's content into `operational_logs`.
        resolve(
          error
            ? { delivered: false, reason: describeFailure(error) }
            : { delivered: true },
        );
      },
    );
  });
}
