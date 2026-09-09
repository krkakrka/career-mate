import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { acquireLockAsync, releaseLock } from '../lib/file-lock.js';
import { getDataDir } from '../lib/paths.js';

function profileDir(): string {
  return path.join(getDataDir(), 'browser-profile');
}

function profileLockPath(): string {
  return `${profileDir()}.lock`;
}

export interface WithPersistentBrowserOptions {
  headless?: boolean;
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
 */
export async function withPersistentBrowser<T>(
  fn: (context: BrowserContext) => Promise<T>,
  options: WithPersistentBrowserOptions = {},
): Promise<T> {
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });

  const lockPath = profileLockPath();
  // Browser launch/navigation is slower than a DB op, and cm auth
  // login-browser can hold this lock for an entire interactive login
  // session — generous timeout; a timeout here just means this job retries
  // later via the queue's own backoff, which is an acceptable degrade.
  await acquireLockAsync(lockPath, 30_000);

  try {
    const context = await chromium.launchPersistentContext(dir, { headless: options.headless ?? true });
    try {
      return await fn(context);
    } finally {
      try {
        await context.close();
      } catch {
        // Already closed — e.g. the user closed the browser window themselves during login-browser.
      }
    }
  } finally {
    releaseLock(lockPath);
  }
}

const FETCH_TIMEOUT_MS = 20_000;

/** Fetches a page's rendered HTML using the authenticated persistent profile. Login-gated equivalent of enrichment/fetch-page.ts's plain fetch. */
export async function fetchAuthenticatedPage(url: string): Promise<string> {
  return withPersistentBrowser(async (context) => {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT_MS });
    return page.content();
  });
}
