import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { defaultHarPath, redactHarSecrets } from '../../browser/har.js';
import {
  fetchAuthenticatedPageDetailed,
  withPersistentBrowser,
  type AuthenticatedFetchResult,
} from '../../browser/profile.js';
import { parseHttpUrl } from '../parsers.js';

/** The trace a thrown browser error carries, attached by withPersistentBrowserTraced. */
function tracePathOf(error: unknown): string | undefined {
  const candidate = (error as { tracePath?: unknown })?.tracePath;
  return typeof candidate === 'string' ? candidate : undefined;
}

function reportTrace(tracePath: string | undefined): void {
  if (!tracePath) return;
  console.log(`Trace: ${tracePath}`);
  console.log(`  view with: npx playwright show-trace ${tracePath}`);
}

/**
 * Prints what the fetch actually did.
 *
 * The final URL is on its own line whenever it moved: a silent redirect to
 * a login wall is the single most likely way this path "works" while
 * returning nothing useful, and a 200 alone cannot tell you that happened.
 */
function reportFetch(url: string, result: AuthenticatedFetchResult): void {
  console.log(`Status: ${result.status ?? '(no response)'}`);
  console.log(`Bytes: ${result.bytes}`);
  console.log(`Took: ${result.durationMs} ms (plus ${result.setupMs} ms waiting for the profile and starting the browser)`);
  // Compared normalised: the browser turns `https://example.com` into
  // `https://example.com/`, and reporting that as a redirect would cry wolf
  // on the most ordinary URL a user can type.
  if (result.finalUrl !== new URL(url).href) console.log(`Redirected to: ${result.finalUrl}`);
  reportTrace(result.tracePath);
}


export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Manage session reuse for login-gated sources');

  auth
    .command('login-browser')
    .description('Open a browser against the dedicated automation profile so you can log in once')
    .action(async () => {
      console.log('Opening a browser window. Log into whatever sites you need (Glassdoor, etc.), then close the window when done — the session will be reused for future headless fetches.');
      await withPersistentBrowser(
        async (context) => {
          const page = context.pages()[0] ?? (await context.newPage());
          await page.goto('https://www.glassdoor.com/index.htm');
          await new Promise<void>((resolve) => {
            context.on('close', () => resolve());
          });
        },
        // Never traced, whatever `settings.browser_trace` says.
        //
        // A trace records screenshots and DOM snapshots, so tracing the one
        // command whose entire purpose is typing credentials into someone
        // else's login form would write a screen recording of that to
        // `.data/traces/`. The debugging value does not come close to
        // justifying it; `cm auth check --trace` covers the fetches that
        // follow, where there is nothing secret on screen.
        { headless: false, trace: 'never' },
      );
      console.log('Browser closed. Session saved.');
    });

  auth
    .command('check')
    .description('Fetch a URL through the saved browser session and report what came back')
    .argument('<url>', 'URL to fetch through the persistent profile', parseHttpUrl)
    .option('--trace', 'Keep a Playwright trace even when the fetch succeeds')
    .option('--replay-har <file>', 'Serve requests from a recorded HAR instead of the network')
    .action(async (url: string, opts: { trace?: boolean; replayHar?: string }) => {
      try {
        const result = await fetchAuthenticatedPageDetailed(url, {
          ...(opts.trace ? { trace: 'always' as const } : {}),
          ...(opts.replayHar ? { replayHarPath: path.resolve(opts.replayHar) } : {}),
        });
        reportFetch(url, result);
      } catch (error) {
        // Reported rather than rethrown: "the browser path is broken" is a
        // finding, not a crash, and this command exists precisely to be run
        // when something is wrong. The non-zero exit still makes it usable
        // from a script.
        console.error(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
        reportTrace(tracePathOf(error));
        process.exitCode = 1;
      }
    });

  auth
    .command('record-har')
    .description("Record a URL's traffic to a HAR file, so it can be replayed offline later")
    .argument('<url>', 'URL to visit while recording', parseHttpUrl)
    .option('--out <file>', 'Where to write the HAR (default: .data/har/<host><path>.har)')
    .action(async (url: string, opts: { out?: string }) => {
      const out = opts.out ? path.resolve(opts.out) : defaultHarPath(url);
      // Recorded to a sibling temp file and moved into place only on
      // success. Chromium flushes a HAR on context close whether or not the
      // fetch worked, so writing straight to `out` meant one flaky re-record
      // replaced a good recording — the one you spent a login to capture —
      // with an empty one.
      const staging = `${out}.recording`;

      try {
        const result = await fetchAuthenticatedPageDetailed(url, { recordHarPath: staging });
        reportFetch(url, result);

        const redacted = redactHarSecrets(staging);
        fs.renameSync(staging, out);

        console.log(`HAR: ${out}`);
        // Said every time, not only when something was found: this profile
        // is an authenticated session, and knowing whether the credential
        // was actually stripped is the whole question.
        console.log(`  redacted ${redacted} cookie/auth value(s); response bodies are recorded whole, so check before sharing`);
        console.log(`  replay with: cm auth check ${url} --replay-har ${out}`);
      } catch (error) {
        // Same treatment as `check`: recording a login-gated page that times
        // out or redirects is what this command is *for*, so a failure is a
        // finding rather than an unhandled rejection stack.
        console.error(`Recording failed: ${error instanceof Error ? error.message : String(error)}`);
        reportTrace(tracePathOf(error));
        // The partial recording goes, and whatever was already at `out`
        // stays exactly as it was.
        fs.rmSync(staging, { force: true });
        if (fs.existsSync(out)) console.error(`Left the existing recording at ${out} untouched.`);
        process.exitCode = 1;
      }
    });
}
