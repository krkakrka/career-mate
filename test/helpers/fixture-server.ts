import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts a tiny local HTTP server serving fixed HTML per path — the deterministic stand-in for a real site in fetch-dependent tests. */
export function startFixtureServer(routes: Record<string, string>): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const body = routes[req.url ?? ''];
      if (body === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
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
