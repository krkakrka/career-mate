import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { loadSettings } from '../config/settings.js';
import { acquireLockAsync, releaseLock } from '../lib/file-lock.js';
import { getDataDir } from '../lib/paths.js';
import { allocateTracePath, pruneTraces, type TraceMode } from './trace.js';

function profileDir(): string {
  return path.join(getDataDir(), 'browser-profile');
}

function profileLockPath(): string {
  return `${profileDir()}.lock`;
}

export interface WithPersistentBrowserOptions {
  headless?: boolean;
  /**
   * When to keep a Playwright trace of this run. Defaults to
   * `settings.browser_trace`.
   */
  trace?: TraceMode;
  /** What the trace file is named after — a URL where there is one. */
  traceLabel?: string;
  /**
   * Record every request this run makes to a HAR at this path.
   *
   * Written by Chromium on context close, so the file does not exist until
   * `withPersistentBrowser` returns.
   */
  recordHarPath?: string;
  /**
   * Serve matching requests from this HAR instead of the network.
   *
   * Anything the HAR does not contain is aborted rather than fetched, so a
   * replay that silently reaches the real site is not possible — which is
   * the whole point of recording one.
   */
  replayHarPath?: string;
}

export interface BrowserRunResult<T> {
  value: T;
  /** Where the trace was written, or undefined when the mode did not call for one. */
  tracePath?: string;
  /**
   * Time spent waiting for the profile lock and launching Chromium, before
   * `fn` ran at all.
   *
   * Reported separately rather than folded into the caller's own timing:
   * the daemon can hold the profile lock for a whole fetch, so a page that
   * answered in 200 ms would otherwise be reported as taking 28 seconds —
   * exactly the "is it the plumbing or the road?" confusion `cm auth check`
   * exists to remove.
   */
  setupMs: number;
}

/**
 * Runs `fn` against a Chromium context launched with career-mate's
 * dedicated automation profile — deliberately not your everyday Chrome
 * profile, to avoid lock conflicts and not interfere with your daily
 * browsing. Log in once via `cm auth login-browser`; every later headless
 * call here reuses that same profile's cookies/session automatically.
 *
 * Guarded by a cross-process file lock (the same primitive migrate.ts uses
 * for schema changes, via the async variant — this runs from inside the
 * daemon's already-active event loop, unlike migrations, so it must not
 * block the thread while waiting): only one process may hold the profile
 * directory at a time, since the daemon and a manually-run `cm worker
 * drain` can both be alive at once, and Chromium profile directories
 * don't tolerate concurrent access well — a race here risks corrupting
 * the very session `cm auth login-browser` exists to preserve.
 *
 * That same lock is what makes tracing safe to name by timestamp and to
 * prune inside: no two browser runs overlap, in this process or any other.
 */
export async function withPersistentBrowserTraced<T>(
  fn: (context: BrowserContext) => Promise<T>,
  options: WithPersistentBrowserOptions = {},
): Promise<BrowserRunResult<T>> {
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });

  const settings = loadSettings();
  const mode = options.trace ?? settings.browser_trace;

  const startedAt = Date.now();
  const lockPath = profileLockPath();
  // Browser launch/navigation is slower than a DB op, and cm auth
  // login-browser can hold this lock for an entire interactive login
  // session — generous timeout; a timeout here just means this job retries
  // later via the queue's own backoff, which is an acceptable degrade.
  await acquireLockAsync(lockPath, 30_000);

  try {
    if (options.recordHarPath) fs.mkdirSync(path.dirname(options.recordHarPath), { recursive: true });

    const context = await chromium.launchPersistentContext(dir, {
      headless: options.headless ?? true,
      // `content: 'embed'` puts response bodies inside the HAR itself, so
      // the file is self-contained and a replay cannot depend on a sibling
      // directory that was never copied along with it.
      ...(options.recordHarPath ? { recordHar: { path: options.recordHarPath, content: 'embed' as const } } : {}),
    });

    const setupMs = Date.now() - startedAt;

    let tracePath: string | undefined;
    try {
      if (options.replayHarPath) {
        // `notFound: 'abort'` rather than 'fallback': a replay that quietly
        // reaches the live site would pass while proving nothing, which is
        // the exact failure recording a HAR exists to rule out.
        await context.routeFromHAR(options.replayHarPath, { notFound: 'abort' });
      }
      if (mode !== 'never') {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }

      const value = await fn(context);

      if (mode === 'always') tracePath = await stopTracing(context, options.traceLabel);
      // `on-failure` on a run that succeeded: stop without a path, which
      // discards. Leaving it running would leak the buffer into the next
      // run's trace and grow without bound.
      else if (mode !== 'never') await context.tracing.stop().catch(() => undefined);

      return { value, tracePath, setupMs };
    } catch (error) {
      if (mode !== 'never') tracePath = await stopTracing(context, options.traceLabel);
      // The path is attached to the error rather than returned, because the
      // caller gets no return value on this path — and a trace nobody is
      // told about is a trace nobody opens. Guarded on the error being an
      // object: a thrown string would make `Object.assign` throw and
      // replace the real failure with a TypeError about the trace.
      if (tracePath && typeof error === 'object' && error !== null) Object.assign(error, { tracePath });
      throw error;
    } finally {
      try {
        await context.close();
      } catch {
        // Already closed — e.g. the user closed the browser window themselves during login-browser.
      }
      // Pruned inside the lock, after the trace is fully written: the file
      // Chromium just finished must be prunable like any other, and no
      // other run can be mid-write.
      if (mode !== 'never') pruneTraces(settings.browser_trace_keep, tracePath);
    }
  } finally {
    releaseLock(lockPath);
  }
}

/** Stops tracing into a freshly allocated file, returning where it landed. Never throws — a missing trace must not mask the error it was taken for. */
async function stopTracing(context: BrowserContext, label: string | undefined): Promise<string | undefined> {
  const file = allocateTracePath(label ?? 'browser');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await context.tracing.stop({ path: file });
    return file;
  } catch {
    return undefined;
  }
}

/** The common case, where only the result matters. */
export async function withPersistentBrowser<T>(
  fn: (context: BrowserContext) => Promise<T>,
  options: WithPersistentBrowserOptions = {},
): Promise<T> {
  return (await withPersistentBrowserTraced(fn, options)).value;
}

const FETCH_TIMEOUT_MS = 20_000;

export interface AuthenticatedFetchResult {
  html: string;
  /** HTTP status of the main document, or null when the navigation returned no response (a redirect chain ending in about:blank, say). */
  status: number | null;
  /** Bytes of rendered HTML — what the extraction actually gets, not what the wire carried. */
  bytes: number;
  /** Navigation plus rendering only — not the profile lock wait or the browser launch, which are `setupMs`. */
  durationMs: number;
  /** Profile-lock wait plus Chromium launch. Large here and small in `durationMs` means contention, not a slow site. */
  setupMs: number;
  /** The URL the browser ended on, which is how a silent redirect to a login wall shows itself. */
  finalUrl: string;
  tracePath?: string;
}

/**
 * Fetches a page's rendered HTML using the authenticated persistent profile.
 * Login-gated equivalent of pages/fetch.ts's plain fetch.
 *
 * Reports status, size and wall time alongside the HTML because "is the
 * browser path alive?" had no answer short of an afternoon: the plumbing
 * and the road are separate failures, and only the numbers distinguish a
 * working fetch of a login wall from a broken fetch of the real page.
 */
export async function fetchAuthenticatedPageDetailed(
  url: string,
  options: WithPersistentBrowserOptions = {},
): Promise<AuthenticatedFetchResult> {
  const run = await withPersistentBrowserTraced(
    async (context) => {
      // Clocked here, inside the callback: everything before this point is
      // lock contention and browser startup, which `setupMs` reports on its
      // own. Timing from outside made a 200 ms page read as 28 seconds
      // whenever the daemon happened to hold the profile.
      const started = Date.now();
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT_MS });
      const html = await page.content();
      return { html, status: response?.status() ?? null, finalUrl: page.url(), durationMs: Date.now() - started };
    },
    { traceLabel: url, ...options },
  );

  return {
    ...run.value,
    bytes: Buffer.byteLength(run.value.html, 'utf-8'),
    setupMs: run.setupMs,
    tracePath: run.tracePath,
  };
}

/** Back-compat shape for callers that only want the markup. */
export async function fetchAuthenticatedPage(url: string): Promise<string> {
  return (await fetchAuthenticatedPageDetailed(url)).html;
}
