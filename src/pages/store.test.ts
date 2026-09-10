import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { openDb } from '../db/client.js';
import { getLatestSnapshot, listSnapshotsForUrl } from '../db/repositories/page-snapshots.js';
import { hashUrl, readSnapshotText, resolvePagePath, snapshotPage } from './store.js';
import { deriveText } from './text.js';

const PAGE_HTML = `<!doctype html>
<html>
  <head>
    <title>Staff Engineer at Example Co</title>
    <meta property="og:title" content="Staff Engineer">
    <script>const tracking = { id: "${'z'.repeat(2_000)}" };</script>
  </head>
  <body><h1>Staff Engineer</h1><p>Remote within the EU.</p></body>
</html>`;

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;
let server: FixtureServer | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-pages-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  process.env.CM_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeSettings(settings: Record<string, unknown>): void {
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('snapshotPage', () => {
  it('fetches once and writes the html file, the derived text file, and a row', async () => {
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const url = `${server.url}/job`;

    const snapshot = await snapshotPage(db, url, { kind: 'role' });

    expect(server.requests).toEqual(['/job']);
    expect(snapshot.url).toBe(url);
    expect(snapshot.url_hash).toBe(hashUrl(url));
    expect(snapshot.http_status).toBe(200);
    expect(snapshot.error).toBeNull();
    expect(snapshot.content_hash).toBe(sha256(PAGE_HTML));
    expect(snapshot.text_hash).toBe(sha256(deriveText(PAGE_HTML)));
    expect(snapshot.bytes).toBe(Buffer.byteLength(PAGE_HTML, 'utf-8'));

    expect(fs.readFileSync(resolvePagePath(snapshot.html_path!), 'utf-8')).toBe(PAGE_HTML);
    expect(readSnapshotText(snapshot)).toBe(deriveText(PAGE_HTML));
    // Files land under .data/pages/<url-sha256>/, one directory per URL.
    expect(path.dirname(snapshot.html_path!)).toBe(path.join('pages', hashUrl(url)));
  });

  it('sends the extraction script far less than the raw HTML', async () => {
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const snapshot = await snapshotPage(db, `${server.url}/job`, { kind: 'role' });

    const htmlBytes = fs.statSync(resolvePagePath(snapshot.html_path!)).size;
    const textBytes = fs.statSync(resolvePagePath(snapshot.text_path!)).size;
    expect(textBytes).toBeLessThan(htmlBytes);
  });

  it('makes no HTTP request at all for a snapshot still inside the refresh window', async () => {
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const url = `${server.url}/job`;

    const first = await snapshotPage(db, url, { kind: 'role' });
    const second = await snapshotPage(db, url, { kind: 'role' });

    expect(server.requests).toEqual(['/job']);
    expect(second.id).toBe(first.id);
    expect(listSnapshotsForUrl(db, hashUrl(url))).toHaveLength(1);
  });

  it('applies the per-kind refresh window, not one global one', async () => {
    writeSettings({ page_refresh_days: { role: 0, company: 30 } });
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const url = `${server.url}/job`;

    await snapshotPage(db, url, { kind: 'role' });
    await snapshotPage(db, url, { kind: 'role' });

    // role: 0 days means "never reuse", so both calls fetched.
    expect(server.requests).toEqual(['/job', '/job']);
  });

  it('fetches again with force, ignoring the refresh window', async () => {
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const url = `${server.url}/job`;

    const first = await snapshotPage(db, url, { kind: 'role' });
    const forced = await snapshotPage(db, url, { kind: 'role', force: true });

    expect(server.requests).toEqual(['/job', '/job']);
    expect(forced.id).not.toBe(first.id);
  });

  it('records an unchanged body as its own row while reusing the existing files', async () => {
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const url = `${server.url}/job`;

    const first = await snapshotPage(db, url, { kind: 'role', force: true });
    const second = await snapshotPage(db, url, { kind: 'role', force: true });

    // "We checked and it was unchanged" is a fact worth recording...
    expect(second.id).not.toBe(first.id);
    expect(second.content_hash).toBe(first.content_hash);
    // ...but a byte-identical copy of the file is not.
    expect(second.html_path).toBe(first.html_path);
    expect(second.text_path).toBe(first.text_path);
    expect(fs.readdirSync(path.join(tempDir, 'pages', hashUrl(url)))).toHaveLength(2);
  });

  it('writes a new file pair when the body actually changed, leaving the old snapshot intact', async () => {
    const changed = PAGE_HTML.replace('Remote within the EU.', 'This role has been filled.');
    // Two different bodies at one URL over time is the whole scenario here,
    // so the route is a function the fixture server re-evaluates per request.
    let body = PAGE_HTML;
    server = await startFixtureServer({ '/job': () => body });
    const url = `${server.url}/job`;

    const first = await snapshotPage(db, url, { kind: 'role', force: true });
    body = changed;
    const second = await snapshotPage(db, url, { kind: 'role', force: true });

    expect(second.content_hash).not.toBe(first.content_hash);
    expect(second.text_hash).not.toBe(first.text_hash);
    expect(second.html_path).not.toBe(first.html_path);
    // The first snapshot is immutable — still on disk, still readable.
    expect(fs.readFileSync(resolvePagePath(first.html_path!), 'utf-8')).toBe(PAGE_HTML);
    expect(readSnapshotText(second)).toContain('This role has been filled.');
  });

  it('records a row with the error and no files on an HTTP failure, and rethrows', async () => {
    server = await startFixtureServer({ '/gone': { status: 500, body: 'boom' } });
    const url = `${server.url}/gone`;

    await expect(snapshotPage(db, url, { kind: 'role' })).rejects.toMatchObject({ name: 'FetchError', status: 500 });

    const snapshot = getLatestSnapshot(db, hashUrl(url))!;
    expect(snapshot.http_status).toBe(500);
    expect(snapshot.error).toContain('HTTP 500');
    expect(snapshot.content_hash).toBeNull();
    expect(snapshot.html_path).toBeNull();
    expect(snapshot.text_path).toBeNull();
    expect(fs.existsSync(path.join(tempDir, 'pages', hashUrl(url)))).toBe(false);
  });

  it('records whether the stored body hit the size cap', async () => {
    server = await startFixtureServer({ '/small': PAGE_HTML, '/huge': `<p>${'x'.repeat(600_000)}</p>` });

    expect((await snapshotPage(db, `${server.url}/small`, { kind: 'role' })).truncated).toBe(0);
    expect((await snapshotPage(db, `${server.url}/huge`, { kind: 'role' })).truncated).toBe(1);
  });

  it('stores exactly the bytes that content_hash covers', async () => {
    // The emoji makes this fail if anything on the write path re-encodes.
    server = await startFixtureServer({ '/job': `<p>Ship it 🚀 — €90k</p>` });
    const snapshot = await snapshotPage(db, `${server.url}/job`, { kind: 'role' });

    const onDisk = fs.readFileSync(resolvePagePath(snapshot.html_path!), 'utf-8');
    expect(sha256(onDisk)).toBe(snapshot.content_hash);
    expect(snapshot.bytes).toBe(fs.statSync(resolvePagePath(snapshot.html_path!)).size);
  });

  it('reports the fetch failure itself even when recording the attempt is impossible', async () => {
    server = await startFixtureServer({ '/gone': { status: 404 } });
    // Drop the table out from under the bookkeeping insert: the closure
    // check keys off FetchError.status, so a failure to record the attempt
    // must not replace a real 404 with some other error. `force` skips the
    // pre-fetch read, leaving the insert in the catch block as the only
    // statement that touches the (now missing) table.
    db.exec('DROP TABLE page_snapshots');

    await expect(snapshotPage(db, `${server.url}/gone`, { kind: 'role', force: true })).rejects.toMatchObject({
      name: 'FetchError',
      status: 404,
    });
  });

  it('records a network-level failure with no http_status', async () => {
    const url = 'http://127.0.0.1:1/unreachable';
    await expect(snapshotPage(db, url, { kind: 'role' })).rejects.toMatchObject({ name: 'FetchError' });

    const snapshot = getLatestSnapshot(db, hashUrl(url))!;
    expect(snapshot.http_status).toBeNull();
    expect(snapshot.error).toBeTruthy();
  });

  it('does not let a failed attempt suppress the next fetch inside the refresh window', async () => {
    let status = 503;
    server = await startFixtureServer({
      '/job': () => (status === 503 ? { status: 503, body: 'unavailable' } : PAGE_HTML),
    });
    const url = `${server.url}/job`;

    await expect(snapshotPage(db, url, { kind: 'role' })).rejects.toMatchObject({ name: 'FetchError' });
    status = 200;
    const recovered = await snapshotPage(db, url, { kind: 'role' });

    expect(recovered.content_hash).toBe(sha256(PAGE_HTML));
    expect(server.requests).toEqual(['/job', '/job']);
  });

  it('re-fetches when the cached snapshot files have been deleted from disk', async () => {
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const url = `${server.url}/job`;

    const first = await snapshotPage(db, url, { kind: 'role' });
    fs.rmSync(path.join(tempDir, 'pages'), { recursive: true, force: true });
    const second = await snapshotPage(db, url, { kind: 'role' });

    expect(server.requests).toEqual(['/job', '/job']);
    expect(readSnapshotText(second)).toBe(deriveText(PAGE_HTML));
  });

  it('never lets concurrent snapshots of the same URL land on the same file', async () => {
    // Distinct content per request, fetched concurrently, so all three
    // snapshots are taken within the same millisecond and *must not* share
    // a filename — one row pointing at another row's content would be
    // silent corruption of an append-only store.
    let counter = 0;
    server = await startFixtureServer({
      '/job': () => PAGE_HTML.replace('<h1>Staff Engineer</h1>', `<h1>Staff Engineer ${(counter += 1)}</h1>`),
    });
    const url = `${server.url}/job`;

    const snapshots = await Promise.all([
      snapshotPage(db, url, { kind: 'role', force: true }),
      snapshotPage(db, url, { kind: 'role', force: true }),
      snapshotPage(db, url, { kind: 'role', force: true }),
    ]);

    expect(new Set(snapshots.map((snapshot) => snapshot.html_path)).size).toBe(3);
    for (const snapshot of snapshots) {
      const html = fs.readFileSync(resolvePagePath(snapshot.html_path!), 'utf-8');
      expect(sha256(html)).toBe(snapshot.content_hash);
      expect(sha256(readSnapshotText(snapshot))).toBe(snapshot.text_hash);
    }
  });

  it('leaves no temp files behind', async () => {
    server = await startFixtureServer({ '/job': PAGE_HTML });
    const url = `${server.url}/job`;
    await snapshotPage(db, url, { kind: 'role', force: true });

    expect(fs.readdirSync(path.join(tempDir, 'pages', hashUrl(url)))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.html$/), expect.stringMatching(/\.txt$/)]),
    );
    expect(fs.readdirSync(path.join(tempDir, 'pages', hashUrl(url)))).toHaveLength(2);
  });

  it('keeps snapshots of different URLs in separate directories', async () => {
    server = await startFixtureServer({ '/a': PAGE_HTML, '/b': '<title>Other</title>' });

    const a = await snapshotPage(db, `${server.url}/a`, { kind: 'role' });
    const b = await snapshotPage(db, `${server.url}/b`, { kind: 'role' });

    expect(path.dirname(a.html_path!)).not.toBe(path.dirname(b.html_path!));
    expect(fs.readdirSync(path.join(tempDir, 'pages'))).toHaveLength(2);
  });
});

describe('readSnapshotText', () => {
  it('throws a message naming the URL when a snapshot captured no content', async () => {
    server = await startFixtureServer({ '/gone': { status: 500 } });
    const url = `${server.url}/gone`;
    await expect(snapshotPage(db, url, { kind: 'role' })).rejects.toThrow();

    expect(() => readSnapshotText(getLatestSnapshot(db, hashUrl(url))!)).toThrow(/no derived text/);
  });
});
