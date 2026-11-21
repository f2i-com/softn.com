import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { test as base } from '@playwright/test';

// The preview server closes each PHP connection. Forwarding its Connection
// header also closes the browser's socket after every small precache file.
// Each side of the proxy should manage its own connections.
function endToEndHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result = { ...headers };
  for (const name of (headers.connection ?? '').split(',')) delete result[name.trim().toLowerCase()];
  for (const name of ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']) delete result[name];
  return result;
}

interface OfflineSite {
  origin: string;
  disconnect: () => void;
  /** Includes service-worker requests which some browsers omit from page events. */
  requestedPaths: Set<string>;
}

// Serve the real deployment on an origin this test can actually switch off. Playwright's
// offline emulation on Windows WebKit rejects document navigations before its service
// worker can respond. Closing the listener leaves the browser's real caches in charge.
export const test = base.extend<{ offlineSite: OfflineSite }>({
  offlineSite: async ({ baseURL }, use) => {
    const upstream = new URL(baseURL!);
    const request = upstream.protocol === 'https:' ? https.request : http.request;
    const agent = upstream.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, maxSockets: 8 })
      : new http.Agent({ keepAlive: true, maxSockets: 8 });
    const requestedPaths = new Set<string>();
    const server = http.createServer((req, res) => {
      if (req.url) requestedPaths.add(new URL(req.url, upstream).pathname);
      const remote = request(upstream, {
        path: req.url,
        method: req.method,
        headers: { ...endToEndHeaders(req.headers), host: upstream.host },
        agent,
      }, (reply) => {
        res.writeHead(reply.statusCode!, endToEndHeaders(reply.headers));
        reply.on('error', () => res.destroy());
        reply.pipe(res);
      });
      remote.on('error', () => res.destroy());
      req.pipe(remote);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const disconnect = () => {
      if (server.listening) server.close();
      server.closeAllConnections();
      agent.destroy();
    };
    try {
      await use({ origin: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, disconnect, requestedPaths });
    } finally {
      disconnect();
    }
  },
});
