import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

export type FixtureRoute = string | { status: number; body?: string };

/** Starts a tiny local HTTP server serving fixed HTML (or a custom status, e.g. to test a non-200/404 response) per path — the deterministic stand-in for a real site in fetch-dependent tests. */
export function startFixtureServer(routes: Record<string, FixtureRoute>): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url ?? ''];
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
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
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
