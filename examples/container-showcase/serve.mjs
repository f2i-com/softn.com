#!/usr/bin/env node
/**
 * Serves the SoftN v2 Container Showcase (`http://127.0.0.1:4830/`).
 * Automatically serves pre-compressed `.wasm.br` (~760 KB) when the browser accepts Brotli!
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '..', '..');
const RUNTIME_DIR = path.join(REPO_ROOT, 'packages', '@softn', 'container', 'dist', 'runtime');
const BUNDLES_DIR = path.join(DIR, 'bundles');

if (!fs.existsSync(path.join(BUNDLES_DIR, 'compiled-kanban.softn'))) {
  execFileSync(process.execPath, [path.join(DIR, 'build.mjs')], { stdio: 'inherit' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.softn': 'application/zip',
  '.map': 'application/json',
};

const port = Number(process.env.CONTAINER_PORT) || 4830;

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  let filePath;
  if (urlPath === '/' || urlPath === '/index.html') {
    filePath = path.join(DIR, 'index.html');
  } else if (urlPath.startsWith('/runtime/')) {
    const rel = path.normalize(urlPath.slice('/runtime/'.length));
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    filePath = path.join(RUNTIME_DIR, rel);
  } else if (urlPath.startsWith('/bundles/')) {
    const rel = path.normalize(urlPath.slice('/bundles/'.length));
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    filePath = path.join(BUNDLES_DIR, rel);
  } else {
    res.writeHead(404).end('Not found');
    return;
  }

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
    res.writeHead(404).end('Not found');
    return;
  }

  const bytes = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-cache',
  });
  res.end(bytes);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`SoftN v2 Container Showcase listening at http://127.0.0.1:${port}/`);
});
