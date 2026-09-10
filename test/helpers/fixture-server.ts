import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  url: string;
  /** Every path requested, in order — lets a test assert that a call made *no* HTTP request at all. */
  requests: string[];
  close: () => Promise<void>;
}

export type FixtureResponse = string | { status: number; body?: string };
/** A function route is re-evaluated per request, so a test can change what a URL serves between fetches. */
export type FixtureRoute = FixtureResponse | (() => FixtureResponse);

/** Starts a tiny local HTTP server serving fixed HTML (or a custom status, e.g. to test a non-200/404 response) per path — the deterministic stand-in for a real site in fetch-dependent tests. */
export function startFixtureServer(routes: Record<string, FixtureRoute>): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      const declared = routes[req.url ?? ''];
      if (declared === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const route = typeof declared === 'function' ? declared() : declared;
      if (typeof route === 'string') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(route);
        return;
      }
      res.writeHead(route.status, { 'content-type': 'text/plain' });
      res.end(route.body ?? '');
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
