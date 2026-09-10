import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { withPersistentBrowser } from './profile.js';
import { restoreEnv } from '../../test/helpers/env.js';

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
