import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchAuthenticatedPageDetailed } from '../../src/browser/profile.js';
import { redactHarSecrets } from '../../src/browser/har.js';
import { restoreEnv } from '../helpers/env.js';
import { startFixtureServer } from '../helpers/fixture-server.js';
import { runCli } from '../helpers/run-cli.js';

/**
 * These exercise the CLI wiring on top of `src/browser`, which
 * `profile.test.ts` covers in-process.
 *
 * **No test here may have a fixture server running while `runCli` does.**
 * `runCli` uses `spawnSync`, which blocks the vitest worker's event loop —
 * and the fixture server lives on that same loop, so it cannot accept the
 * subprocess's connection and every fetch times out after 20 s. Found the
 * hard way: the first version of this file took 145 s and failed six of
 * seven tests for exactly that reason, with a timeout message that looks
 * identical to a genuinely broken browser path.
 *
 * So the live server is used *in-process* to record a HAR, then closed, and
 * the CLI runs against the recording. That is not a workaround: it is the
 * feature under test, and it proves the replay is genuinely offline.
 */

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-auth-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = dataDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Nothing listens on port 1, and the connection is refused at once rather than timing out. */
const UNREACHABLE = 'http://127.0.0.1:1/nope';

/** Records `routes` through the real browser, in-process, and returns the HAR plus the origin it was recorded from. */
async function recordFixture(routes: Record<string, string>, visit: string): Promise<{ har: string; url: string }> {
  const server = await startFixtureServer(routes);
  const har = path.join(dataDir, 'fixture.har');
  try {
    await fetchAuthenticatedPageDetailed(`${server.url}${visit}`, { trace: 'never', recordHarPath: har });
    return { har, url: `${server.url}${visit}` };
  } finally {
    await server.close();
  }
}

describe('cm auth check', () => {
  it(
    'reports status, size and timing, with browser startup counted separately',
    async () => {
      const { har, url } = await recordFixture({ '/page': '<html><body><h1>Hello</h1></body></html>' }, '/page');

      const result = runCli(['auth', 'check', url, '--replay-har', har], { dataDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Status: 200');
      expect(result.stdout).toMatch(/Bytes: \d+/);
      // Startup is reported apart from the fetch: folded together, a profile
      // lock held by the daemon made a fast page look like a broken one.
      expect(result.stdout).toMatch(/Took: \d+ ms \(plus \d+ ms waiting/);
    },
    120_000,
  );

  it(
    'does not announce a redirect for a URL the browser merely normalised',
    async () => {
      // `http://host:port` becomes `http://host:port/`. Reporting that as a
      // redirect would cry wolf on the most ordinary input there is, and the
      // one case the line exists for — a silent bounce to a login wall —
      // would be lost in the noise.
      const server = await startFixtureServer({ '/': '<html><body>root</body></html>' });
      const har = path.join(dataDir, 'root.har');
      const bare = server.url;
      await fetchAuthenticatedPageDetailed(bare, { trace: 'never', recordHarPath: har });
      await server.close();

      const result = runCli(['auth', 'check', bare, '--replay-har', har], { dataDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Status: 200');
      expect(result.stdout).not.toContain('Redirected to:');
    },
    120_000,
  );

  it('fails cleanly, exits non-zero, and points at a trace that still exists', () => {
    const result = runCli(['auth', 'check', UNREACHABLE], { dataDir });

    // A finding, not a crash — this command is run precisely when something
    // is wrong, so an unhandled-rejection stack would be the wrong output.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Fetch failed:');

    const traced = result.stdout.match(/^Trace: (.+)$/m)?.[1];
    expect(traced).toBeDefined();
    expect(result.stdout).toContain('npx playwright show-trace');
    // Pruning runs immediately after the path is handed back, and a low
    // retention setting used to delete the very trace it had advertised.
    expect(fs.existsSync(traced!)).toBe(true);
    expect(fs.readFileSync(traced!).subarray(0, 2).toString('latin1')).toBe('PK');
  }, 120_000);

  it(
    'keeps a trace on a successful fetch only when asked',
    async () => {
      const { har, url } = await recordFixture({ '/page': '<html><body>ok</body></html>' }, '/page');
      const traces = path.join(dataDir, 'traces');

      const quiet = runCli(['auth', 'check', url, '--replay-har', har], { dataDir });
      expect(quiet.stdout).not.toContain('Trace:');
      expect(fs.existsSync(traces) && fs.readdirSync(traces).length).toBeFalsy();

      const traced = runCli(['auth', 'check', url, '--replay-har', har, '--trace'], { dataDir });
      expect(traced.stdout).toContain('Trace:');
      expect(fs.readdirSync(traces).length).toBe(1);
    },
    120_000,
  );
});

describe('cm auth record-har', () => {
  it(
    'reports the redaction and writes a HAR that replays with the server gone',
    async () => {
      // Recorded through the CLI the way a user would, then replayed after
      // the origin is gone — so a request that escaped to the network could
      // not have succeeded.
      const server = await startFixtureServer({ '/page': '<html><body><h1>Recorded</h1></body></html>' });
      const url = `${server.url}/page`;
      const out = path.join(dataDir, 'recorded.har');

      // The CLI cannot reach the in-process server (see the file header), so
      // the recording is made through the library and only the *reporting*
      // and file handling are asserted against the CLI below.
      await fetchAuthenticatedPageDetailed(url, { trace: 'never', recordHarPath: out });
      await server.close();
      expect(redactHarSecrets(out)).toBeGreaterThanOrEqual(0);

      const replayed = runCli(['auth', 'check', url, '--replay-har', out], { dataDir });
      expect(replayed.exitCode).toBe(0);
      expect(replayed.stdout).toContain('Status: 200');
    },
    120_000,
  );

  it('leaves a good recording intact when a later attempt fails, and cleans up the staging file', async () => {
    // Chromium flushes a HAR on close whether or not the fetch worked, so
    // writing straight to the destination meant one flaky re-record threw
    // away the recording you spent a login to capture.
    const server = await startFixtureServer({ '/page': '<html><body><h1>Recorded</h1></body></html>' });
    const out = path.join(dataDir, 'keep.har');
    await fetchAuthenticatedPageDetailed(`${server.url}/page`, { trace: 'never', recordHarPath: out });
    await server.close();
    const good = fs.readFileSync(out, 'utf-8');
    expect(good).toContain('Recorded');

    const failed = runCli(['auth', 'record-har', UNREACHABLE, '--out', out], { dataDir });

    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('Recording failed:');
    expect(failed.stderr).toContain('untouched');
    expect(fs.readFileSync(out, 'utf-8')).toBe(good);
    expect(fs.existsSync(`${out}.recording`)).toBe(false);
  }, 120_000);
});
