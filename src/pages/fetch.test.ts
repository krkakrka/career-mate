import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { fetchRawPage, FetchError, MAX_CONTENT_LENGTH } from './fetch.js';

let server: FixtureServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('fetchRawPage', () => {
  it('budgets memory, not model input — the cap is far above a real page now that the model reads derived text', () => {
    // The old 500KB cap was applied after script/style were stripped. A raw
    // body cap of the same size would be spent on an SPA's inline bootstrap
    // JSON before reaching the job description.
    expect(MAX_CONTENT_LENGTH).toBeGreaterThan(1_000_000);
  });

  it('returns the body and status on a 200', async () => {
    server = await startFixtureServer({ '/hello': '<html><body><h1>Hello</h1></body></html>' });
    const page = await fetchRawPage(`${server.url}/hello`);
    expect(page.status).toBe(200);
    expect(page.html).toBe('<html><body><h1>Hello</h1></body></html>');
    expect(page.truncated).toBe(false);
  });

  it('returns the body exactly as served — script/style stripping belongs to the text derivation, not the snapshot', async () => {
    const html = '<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script><p>Visible</p></body></html>';
    server = await startFixtureServer({ '/page': html });
    expect((await fetchRawPage(`${server.url}/page`)).html).toBe(html);
  });

  it('throws FetchError with the HTTP status on a non-ok response', async () => {
    server = await startFixtureServer({});
    await expect(fetchRawPage(`${server.url}/missing`)).rejects.toMatchObject({
      name: 'FetchError',
      status: 404,
    });
  });

  it('throws FetchError with no status on a network-level failure (nothing listening)', async () => {
    // Port 1 is a reserved/unused port unlikely to have anything listening.
    await expect(fetchRawPage('http://127.0.0.1:1/unreachable')).rejects.toBeInstanceOf(FetchError);
    await expect(fetchRawPage('http://127.0.0.1:1/unreachable')).rejects.toMatchObject({ status: undefined });
  });

  it('never truncates through a surrogate pair, so the string still round-trips as UTF-8', async () => {
    // Pad to exactly one code unit short of the cap, so the emoji that
    // follows straddles the boundary — a naive slice keeps its high half.
    const emoji = '\u{1F680}';
    server = await startFixtureServer({
      '/huge': `${'x'.repeat(MAX_CONTENT_LENGTH - 1)}${emoji}${'y'.repeat(1_000)}`,
    });

    const { html } = await fetchRawPage(`${server.url}/huge`);

    expect(html).toHaveLength(MAX_CONTENT_LENGTH - 1);
    // A lone surrogate survives in a JS string but becomes U+FFFD once
    // written as UTF-8, which would break content_hash's promise about
    // what is on disk.
    expect(Buffer.from(html, 'utf-8').toString('utf-8')).toBe(html);
  });

  it('truncates a body past the size cap and says so', async () => {
    server = await startFixtureServer({ '/huge': `<p>${'x'.repeat(MAX_CONTENT_LENGTH + 1_000)}</p>` });
    const page = await fetchRawPage(`${server.url}/huge`);
    expect(page.truncated).toBe(true);
    expect(page.html).toHaveLength(MAX_CONTENT_LENGTH);
  });
});
