import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { fetchPageContent, FetchError } from './fetch-page.js';

let server: FixtureServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('fetchPageContent', () => {
  it('returns page content on a 200', async () => {
    server = await startFixtureServer({ '/hello': '<html><body><h1>Hello</h1></body></html>' });
    const content = await fetchPageContent(`${server.url}/hello`);
    expect(content).toContain('Hello');
  });

  it('strips script and style tag contents', async () => {
    server = await startFixtureServer({
      '/page': '<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script><p>Visible</p></body></html>',
    });
    const content = await fetchPageContent(`${server.url}/page`);
    expect(content).toContain('Visible');
    expect(content).not.toContain('alert(1)');
    expect(content).not.toContain('color:red');
  });

  it('throws FetchError with the HTTP status on a non-ok response', async () => {
    server = await startFixtureServer({});
    await expect(fetchPageContent(`${server.url}/missing`)).rejects.toMatchObject({
      name: 'FetchError',
      status: 404,
    });
  });

  it('throws FetchError with no status on a network-level failure (nothing listening)', async () => {
    // Port 1 is a reserved/unused port unlikely to have anything listening.
    await expect(fetchPageContent('http://127.0.0.1:1/unreachable')).rejects.toMatchObject({
      name: 'FetchError',
      status: undefined,
    });
  });
});
