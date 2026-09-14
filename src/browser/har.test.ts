import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { defaultHarPath, REDACTED, redactHarSecrets } from './har.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-har-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A HAR shaped the way Chromium writes one, carrying a live session. */
function writeHar(): string {
  const file = path.join(dir, 'fixture.har');
  fs.writeFileSync(
    file,
    JSON.stringify({
      log: {
        version: '1.2',
        entries: [
          {
            request: {
              url: 'https://glassdoor.example/dashboard',
              headers: [
                { name: 'Cookie', value: 'session=SUPERSECRET123; theme=dark' },
                { name: 'authorization', value: 'Bearer eyJhbGciOi' },
                { name: 'Accept', value: 'text/html' },
              ],
              cookies: [{ name: 'session', value: 'SUPERSECRET123' }],
            },
            response: {
              headers: [
                { name: 'set-cookie', value: 'session=ROTATED456; Path=/' },
                { name: 'content-type', value: 'text/html' },
              ],
              cookies: [{ name: 'session', value: 'ROTATED456' }],
              content: { text: '<html><body>Welcome back</body></html>' },
            },
          },
        ],
      },
    }),
  );
  return file;
}

describe('redactHarSecrets', () => {
  it('removes every credential-bearing header and cookie', () => {
    const file = writeHar();

    expect(redactHarSecrets(file)).toBe(5);

    const text = fs.readFileSync(file, 'utf-8');
    // The whole point of this profile is an authenticated session, so every
    // recording of a login-gated page would otherwise be a credential file
    // that `--out` happily writes next to the source tree.
    expect(text).not.toContain('SUPERSECRET123');
    expect(text).not.toContain('ROTATED456');
    expect(text).not.toContain('eyJhbGciOi');
    expect(text).toContain(REDACTED);
  });

  it('leaves everything replay depends on intact', () => {
    // routeFromHAR matches on URL and method and serves the recorded body;
    // it never reads these headers back. Redaction must therefore cost the
    // feature nothing — if it did, the safe option would be unusable.
    const file = writeHar();
    redactHarSecrets(file);

    const har = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const entry = har.log.entries[0];
    expect(entry.request.url).toBe('https://glassdoor.example/dashboard');
    expect(entry.response.content.text).toBe('<html><body>Welcome back</body></html>');
    expect(entry.request.headers).toContainEqual({ name: 'Accept', value: 'text/html' });
    expect(entry.response.headers).toContainEqual({ name: 'content-type', value: 'text/html' });
  });

  it('matches header names case-insensitively', () => {
    const file = path.join(dir, 'case.har');
    fs.writeFileSync(
      file,
      JSON.stringify({
        log: { entries: [{ request: { headers: [{ name: 'COOKIE', value: 'session=x' }] }, response: {} }] },
      }),
    );
    expect(redactHarSecrets(file)).toBe(1);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('session=x');
  });

  it('reports nothing rather than throwing on a HAR it cannot parse', () => {
    // Best effort by construction: this runs after a fetch has already
    // happened, and a redaction failure must not be what fails the command.
    const file = path.join(dir, 'broken.har');
    fs.writeFileSync(file, '{ not json');
    expect(redactHarSecrets(file)).toBe(0);
    expect(redactHarSecrets(path.join(dir, 'missing.har'))).toBe(0);
  });

  it('tolerates a HAR with no entries at all', () => {
    // What a failed recording produces — Chromium still flushes the file.
    const file = path.join(dir, 'empty.har');
    fs.writeFileSync(file, JSON.stringify({ log: { version: '1.2', entries: [] } }));
    expect(redactHarSecrets(file)).toBe(0);
  });
});

describe('defaultHarPath', () => {
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.CM_DATA_DIR;
    process.env.CM_DATA_DIR = dir;
  });

  afterEach(() => {
    restoreEnv('CM_DATA_DIR', originalDataDir);
  });

  it('keys on the whole URL so two pages on one site do not collide', () => {
    // A listing and a detail page on the same host is the normal case; a
    // host-only name made the second recording silently replace the first.
    const one = defaultHarPath('https://jobs.example.com/roles/one');
    const two = defaultHarPath('https://jobs.example.com/roles/two');

    expect(one).not.toBe(two);
    expect(path.basename(one)).toBe('jobs.example.com-roles-one.har');
    expect(path.dirname(one)).toBe(path.join(dir, 'har'));
  });

  it('still produces a usable name for a bare host', () => {
    expect(path.basename(defaultHarPath('https://example.com'))).toBe('example.com.har');
  });

  it('caps a pathological path rather than building an unwritable name', () => {
    const file = defaultHarPath(`https://example.com/${'x'.repeat(500)}`);
    expect(path.basename(file).length).toBeLessThanOrEqual(84);
  });
});
