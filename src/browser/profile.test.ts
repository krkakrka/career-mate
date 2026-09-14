import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { fetchAuthenticatedPageDetailed, withPersistentBrowser } from './profile.js';
import { restoreEnv } from '../../test/helpers/env.js';
import { tracesDir } from './trace.js';
import { redactHarSecrets } from './har.js';

let dataDir: string;
let originalDataDir: string | undefined;
let server: FixtureServer | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-browser-profile-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = dataDir;
});

afterEach(async () => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  await server?.close();
  server = undefined;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('withPersistentBrowser', () => {
  it(
    'can navigate to and read a local fixture page',
    async () => {
      server = await startFixtureServer({ '/hello': '<html><body><h1>Hello</h1></body></html>' });

      const content = await withPersistentBrowser(async (context) => {
        const page = await context.newPage();
        await page.goto(`${server!.url}/hello`);
        return page.content();
      });

      expect(content).toContain('Hello');
    },
    30_000,
  );
});

interface CookieServer {
  url: string;
  close: () => Promise<void>;
}

/** A tiny dedicated server for the session-persistence test — startFixtureServer only serves static bodies, no cookie logic. */
function startCookieServer(): Promise<CookieServer> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => {
      const cookieHeader = req.headers.cookie ?? '';
      if (req.url === '/login') {
        // Max-Age matters: a cookie with no expiry is a *session* cookie,
        // which Chromium correctly (and intentionally) discards when the
        // browser closes — confirmed by hand while writing this test, not
        // an assumption. Real login systems issue persistent, expiring
        // cookies for "stay logged in," which is what this needs to model.
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'session=abc123; Path=/; Max-Age=86400',
        });
        res.end('<html><body>Logged in</body></html>');
        return;
      }
      if (req.url === '/dashboard') {
        const loggedIn = cookieHeader.includes('session=abc123');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><body>${loggedIn ? 'Welcome, logged in!' : 'Please log in'}</body></html>`);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    httpServer.on('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => httpServer.close(() => res())),
      });
    });
  });
}

describe('session persistence across separate launches of the same profile', () => {
  it(
    'a cookie set during one launch (simulating cm auth login-browser) is present in a later, separate headless launch (simulating a research fetch)',
    async () => {
      const cookieServer = await startCookieServer();
      try {
        await withPersistentBrowser(async (context) => {
          const page = await context.newPage();
          await page.goto(`${cookieServer.url}/login`);
        });

        const dashboardContent = await withPersistentBrowser(async (context) => {
          const page = await context.newPage();
          await page.goto(`${cookieServer.url}/dashboard`);
          return page.content();
        });

        expect(dashboardContent).toContain('Welcome, logged in!');
      } finally {
        await cookieServer.close();
      }
    },
    30_000,
  );
});

describe('authenticated fetch reporting', () => {
  it(
    'reports status, bytes, wall time and where it ended up',
    async () => {
      // The whole point of `cm auth check`: "is the browser path alive?"
      // had no answer short of an afternoon, because a working fetch of a
      // login wall and a broken fetch of the real page look identical from
      // an exception message.
      server = await startFixtureServer({ '/page': '<html><body><h1>Hello</h1></body></html>' });

      const result = await fetchAuthenticatedPageDetailed(`${server.url}/page`, { trace: 'never' });

      expect(result.status).toBe(200);
      expect(result.html).toContain('Hello');
      expect(result.bytes).toBe(Buffer.byteLength(result.html, 'utf-8'));
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.finalUrl).toBe(`${server!.url}/page`);
      expect(result.tracePath).toBeUndefined();
    },
    60_000,
  );

  it(
    'fails cleanly on an unreachable host rather than hanging or crashing the process',
    async () => {
      // Port 1 on loopback: nothing listens, and the connection is refused
      // immediately rather than timing out, so this stays fast.
      await expect(fetchAuthenticatedPageDetailed('http://127.0.0.1:1/nope', { trace: 'never' })).rejects.toThrow();
    },
    60_000,
  );
});

describe('tracing', () => {
  it(
    'writes a readable zip on failure and nothing on success',
    async () => {
      // A failed login is unanalysable from an exception message; the trace
      // is the only record of whether the request left, what came back, and
      // what the page looked like when it gave up.
      server = await startFixtureServer({ '/page': '<html><body>ok</body></html>' });

      await fetchAuthenticatedPageDetailed(`${server.url}/page`, { trace: 'on-failure' });
      expect(fs.existsSync(tracesDir()) && fs.readdirSync(tracesDir()).length).toBeFalsy();

      const failure = await fetchAuthenticatedPageDetailed('http://127.0.0.1:1/nope', {
        trace: 'on-failure',
      }).catch((error: unknown) => error);

      const tracePath = (failure as { tracePath?: string }).tracePath;
      expect(tracePath).toBeDefined();
      expect(fs.existsSync(tracePath!)).toBe(true);
      // A trace is a zip; "PK" is its magic number. Asserting the bytes
      // rather than just the file's existence is what makes this prove the
      // artefact is openable by `npx playwright show-trace`.
      expect(fs.readFileSync(tracePath!).subarray(0, 2).toString('latin1')).toBe('PK');
    },
    60_000,
  );

  it(
    'keeps a trace on success when asked, and prunes to the configured limit',
    async () => {
      fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), JSON.stringify({ browser_trace_keep: 1 }));
      server = await startFixtureServer({ '/page': '<html><body>ok</body></html>' });

      const first = await fetchAuthenticatedPageDetailed(`${server.url}/page`, { trace: 'always' });
      expect(first.tracePath).toBeDefined();

      const second = await fetchAuthenticatedPageDetailed(`${server.url}/page`, { trace: 'always' });

      // Nothing else on the system deletes these, and each is megabytes.
      expect(fs.readdirSync(tracesDir())).toEqual([path.basename(second.tracePath!)]);
    },
    60_000,
  );
});

describe('HAR record and replay', () => {
  it(
    'replays a recorded page with the origin server gone',
    async () => {
      // The only way to regression-test a real login-gated page without
      // hitting it, and the only way to prove a replay is genuinely offline:
      // the server is closed before the replay runs, so a request that
      // escaped to the network could not succeed.
      const harPath = path.join(dataDir, 'har', 'fixture.har');
      server = await startFixtureServer({ '/page': '<html><body><h1>Recorded</h1></body></html>' });
      const url = `${server.url}/page`;

      const recorded = await fetchAuthenticatedPageDetailed(url, { trace: 'never', recordHarPath: harPath });
      expect(fs.existsSync(harPath)).toBe(true);

      await server.close();
      server = undefined;

      const replayed = await fetchAuthenticatedPageDetailed(url, { trace: 'never', replayHarPath: harPath });
      expect(replayed.html).toBe(recorded.html);
      expect(replayed.html).toContain('Recorded');
    },
    60_000,
  );

  it(
    'aborts a request the HAR does not contain instead of quietly reaching the network',
    async () => {
      // `notFound: 'fallback'` would make a replay that silently hits the
      // live site pass while proving nothing — the exact failure recording
      // a HAR exists to rule out.
      const harPath = path.join(dataDir, 'har', 'fixture.har');
      server = await startFixtureServer({
        '/page': '<html><body>one</body></html>',
        '/other': '<html><body>two</body></html>',
      });

      await fetchAuthenticatedPageDetailed(`${server.url}/page`, { trace: 'never', recordHarPath: harPath });

      await expect(
        fetchAuthenticatedPageDetailed(`${server!.url}/other`, { trace: 'never', replayHarPath: harPath }),
      ).rejects.toThrow();
    },
    60_000,
  );
});

describe('HAR redaction against a real recording', () => {
  it(
    'strips the session cookie Chromium actually recorded, and still replays',
    async () => {
      // Not a synthetic HAR: this is what the profile really writes when it
      // fetches a page as a logged-in user, which is the only case that
      // matters — the whole point of this profile is an authenticated
      // session, so every recording of a gated page is credential-bearing.
      const cookieServer = await startCookieServer();
      const harPath = path.join(dataDir, 'har', 'session.har');

      try {
        await fetchAuthenticatedPageDetailed(`${cookieServer.url}/login`, { trace: 'never' });
        const recorded = await fetchAuthenticatedPageDetailed(`${cookieServer.url}/dashboard`, {
          trace: 'never',
          recordHarPath: harPath,
        });
        expect(recorded.html).toContain('Welcome, logged in!');
        expect(fs.readFileSync(harPath, 'utf-8')).toContain('abc123');

        expect(redactHarSecrets(harPath)).toBeGreaterThan(0);
        expect(fs.readFileSync(harPath, 'utf-8')).not.toContain('abc123');

        await cookieServer.close();

        // Redaction must cost the feature nothing, or the safe option is
        // the unusable one.
        const replayed = await fetchAuthenticatedPageDetailed(`${cookieServer.url}/dashboard`, {
          trace: 'never',
          replayHarPath: harPath,
        });
        expect(replayed.html).toBe(recorded.html);
      } finally {
        await cookieServer.close().catch(() => undefined);
      }
    },
    60_000,
  );
});

describe('timing', () => {
  it(
    'reports the fetch and the browser startup separately',
    async () => {
      // The daemon can hold the profile lock for a whole fetch. Folding that
      // wait into `durationMs` made a 200 ms page read as 28 seconds —
      // precisely the "plumbing or road?" confusion this is meant to remove.
      server = await startFixtureServer({ '/page': '<html><body>ok</body></html>' });

      const result = await fetchAuthenticatedPageDetailed(`${server.url}/page`, { trace: 'never' });

      expect(result.setupMs).toBeGreaterThan(0);
      // Launching Chromium dominates a localhost fetch by a wide margin, so
      // a durationMs that swallowed setup could not satisfy this.
      expect(result.durationMs).toBeLessThan(result.setupMs);
    },
    60_000,
  );
});
