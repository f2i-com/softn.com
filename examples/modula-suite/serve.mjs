#!/usr/bin/env node
/**
 * Serves the Modula Competitor Website & Internal Parent Host (`http://127.0.0.1:4840/`).
 *
 * Mounts:
 * - `/`               -> React Parent Host (`parent-host/dist/`)
 * - `/runtime/*`      -> `@softn/container` runtime & ZIPP/XDB WASM engines (auto `.wasm.br`)
 * - `/bundles/*`      -> Built Modula `.softn` full-stack apps (`modula-*.softn`)
 * - `/business-demos/*` -> Existing SoftN turnkey vertical business packs
 * - `/standalone/<slug>/api/*` -> Optional proxy to native standalone `php -S` servers (via `serve-php.mjs`)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '..', '..');
const HOST_DIST = path.join(DIR, 'parent-host', 'dist');
const RUNTIME_DIR = path.join(REPO_ROOT, 'packages', '@softn', 'container', 'dist', 'runtime');
const BUNDLES_DIR = path.join(DIR, 'bundles');
const BUSINESS_DEMOS_DIR = path.join(REPO_ROOT, 'apps', 'softn-web', 'public', 'business-demos');

const STANDALONE_PORTS = {
  crm: 8101,
  accounting: 8102,
  inventory: 8103,
  projects: 8104,
  hr: 8105,
  helpdesk: 8106,
  website: 8107,
  pos: 8108,
  fieldservice: 8109,
  workspace: 8110,
  events: 8111,
};

if (!fs.existsSync(path.join(HOST_DIST, 'index.html')) || !fs.existsSync(path.join(BUNDLES_DIR, 'modula-crm.softn'))) {
  execFileSync(process.execPath, [path.join(DIR, 'build.mjs')], { stdio: 'inherit' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.softn': 'application/zip',
  '.map': 'application/json',
};

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 350 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function proxyToStandalone(req, res, port, targetPath) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    const upstream = http.request(
      { host: '127.0.0.1', port, path: targetPath, method: req.method, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: `Standalone PHP server on port ${port} is not running (${err.message}). Start it with: node examples/modula-suite/serve-php.mjs`,
        })
      );
    });
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
}

function serveStaticFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const acceptsBr = /\bbr\b/.test(req.headers['accept-encoding'] || '');
  if (ext === '.wasm' && acceptsBr && fs.existsSync(filePath + '.br')) {
    const brBytes = fs.readFileSync(filePath + '.br');
    res.writeHead(200, {
      'Content-Type': 'application/wasm',
      'Content-Encoding': 'br',
      'Content-Length': brBytes.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(brBytes);
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  const bytes = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-cache',
  });
  res.end(bytes);
}

const port = Number(process.env.MODULA_PORT) || 4840;

const server = http.createServer(async (req, res) => {
  const rawUrl = req.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const urlPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const query = qIdx >= 0 ? rawUrl.slice(qIdx) : '';

  if (urlPath === '/api/standalone-status') {
    const servers = {};
    await Promise.all(
      Object.entries(STANDALONE_PORTS).map(async ([slug, p]) => {
        servers[slug] = await probePort(p);
      })
    );
    const payload = Buffer.from(JSON.stringify({ servers }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.byteLength });
    res.end(payload);
    return;
  }

  const standaloneMatch = /^\/standalone\/([a-z0-9-]+)(\/.*)$/i.exec(urlPath);
  if (standaloneMatch) {
    const slug = standaloneMatch[1];
    const rest = standaloneMatch[2] + query;
    const targetPort = STANDALONE_PORTS[slug];
    if (!targetPort) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unknown app slug' }));
      return;
    }
    proxyToStandalone(req, res, targetPort, rest);
    return;
  }

  if (urlPath.startsWith('/runtime/')) {
    const rel = path.normalize(urlPath.slice('/runtime/'.length));
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    serveStaticFile(req, res, path.join(RUNTIME_DIR, rel));
    return;
  }

  if (urlPath.startsWith('/bundles/')) {
    const rel = path.normalize(urlPath.slice('/bundles/'.length));
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    serveStaticFile(req, res, path.join(BUNDLES_DIR, rel));
    return;
  }

  if (urlPath.startsWith('/business-demos/')) {
    const rel = path.normalize(urlPath.slice('/business-demos/'.length));
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    serveStaticFile(req, res, path.join(BUSINESS_DEMOS_DIR, rel));
    return;
  }

  const rel = urlPath === '/' ? 'index.html' : path.normalize(urlPath.replace(/^\/+/, ''));
  if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
  const candidate = path.join(HOST_DIST, rel);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    serveStaticFile(req, res, candidate);
  } else {
    serveStaticFile(req, res, path.join(HOST_DIST, 'index.html'));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Modula Business Suite (SoftN Odoo Alternative) listening at http://127.0.0.1:${port}/`);
});
