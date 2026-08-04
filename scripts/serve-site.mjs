#!/usr/bin/env node
/**
 * Preview the assembled softn.com build from one origin.
 *
 * `npm run preview:site` builds first, then serves `dist/` with the same
 * app-specific SPA fallbacks a deployment needs. A generic static server would
 * send the landing page shell for `/web/app/Notes`; that looks successful at
 * the HTTP layer but boots the wrong React app.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const port = Number(process.env.SOFTN_SITE_PORT || 1420);
const host = process.env.SOFTN_SITE_HOST || '127.0.0.1';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.softn', 'application/octet-stream'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function fallbackFor(pathname) {
  if (pathname === '/web' || pathname.startsWith('/web/')) return 'web/index.html';
  if (pathname === '/builder' || pathname.startsWith('/builder/')) return 'builder/index.html';
  if (pathname === '/studio' || pathname.startsWith('/studio/')) return 'studio/index.html';
  return 'index.html';
}

function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const candidate = path.resolve(distDir, decoded.replace(/^\/+/, ''));
  if (candidate !== distDir && !candidate.startsWith(`${distDir}${path.sep}`)) return null;
  return candidate;
}

function existingFile(candidate) {
  if (!fs.existsSync(candidate)) return null;
  const stat = fs.statSync(candidate);
  if (stat.isFile()) return candidate;
  if (!stat.isDirectory()) return null;
  const index = path.join(candidate, 'index.html');
  return fs.existsSync(index) && fs.statSync(index).isFile() ? index : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed\n', {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  if (['/web', '/builder', '/studio'].includes(pathname)) {
    res.writeHead(308, { Location: `${pathname}/${url.search}` });
    res.end();
    return;
  }

  const candidate = safePath(pathname);
  if (!candidate) {
    send(res, 400, 'Bad request\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let file = existingFile(candidate);
  const acceptsHtml = String(req.headers.accept || '').includes('text/html');
  const extensionlessHead = req.method === 'HEAD' && path.extname(pathname) === '';
  if (!file && (acceptsHtml || extensionlessHead)) {
    file = existingFile(path.join(distDir, fallbackFor(pathname)));
  }
  if (!file) {
    send(res, 404, 'Not found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Length': stat.size,
    'Content-Type': MIME_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/ is missing. Run npm run build:site before starting the preview.');
  process.exit(1);
}

const server = http.createServer(handleRequest);
server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set SOFTN_SITE_PORT to choose another one.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`\n  softn.com preview  http://localhost:${port}`);
  console.log('  /web/              runtime');
  console.log('  /builder/           visual builder');
  console.log('  /studio/            AI studio\n');
});
