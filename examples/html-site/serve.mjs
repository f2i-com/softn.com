// Serves this folder two ways, to try pages written as HTML:
//
//   /       the files as a site of your own, each page starting SoftN with
//           <script src="softn/softn.js"> (softn/ is the standalone runtime's
//           built folder, apps/softn-single/dist)
//   /app/   the same files as one bundle in the standalone runtime, where a
//           link to another page is shown in the app
//
// Build the runtime first (npm run build -w @softn/single), then:
//   node examples/html-site/serve.mjs            (port 4820, or HTML_SITE_PORT)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const dist = path.join(repo, 'apps', 'softn-single', 'dist');
const require = createRequire(path.join(repo, 'package.json'));
const { zipSync, strToU8 } = require('fflate');
const port = Number(process.env.HTML_SITE_PORT || 4820);

if (!fs.existsSync(path.join(dist, 'softn.js'))) {
  console.error('The standalone runtime is not built: run `npm run build -w @softn/single` first.');
  process.exit(1);
}

const SITE_FILES = ['index.html', 'tasks.html', 'about.html', 'main.js', 'styles.css'];

/** The folder as a bundle, read afresh so an edited page shows on reload. */
function bundle() {
  const files = Object.fromEntries(SITE_FILES.map((name) => [name, strToU8(fs.readFileSync(path.join(here, name), 'utf8'))]));
  files['manifest.json'] = strToU8(JSON.stringify({
    name: 'HTML in SoftN',
    version: '1.0.0',
    main: 'index.html',
    files: { ui: ['index.html', 'tasks.html', 'about.html'], logic: ['main.js'], assets: ['styles.css'] },
  }));
  return zipSync(files, { level: 6 });
}

const CONFIG = JSON.stringify({ version: 1, id: 'html-site', title: 'HTML in SoftN', bundle: './app.softn', loadingText: 'Loading…', theme: 'light' });
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function send(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/** A path inside `base`, or null for one that climbs out of it. */
function inside(base, rel) {
  const file = path.join(base, decodeURIComponent(rel));
  return file.startsWith(base + path.sep) || file === base ? file : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/app') {
    res.writeHead(302, { location: '/app/' });
    return res.end();
  }
  if (p === '/app/app.softn') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(bundle());
  }
  if (p === '/app/runtime.config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(CONFIG);
  }
  if (p.startsWith('/app/')) {
    const file = inside(dist, p === '/app/' ? 'index.html' : p.slice('/app/'.length));
    return file ? send(res, file) : send(res, '');
  }
  if (p.startsWith('/softn/')) {
    const file = inside(dist, p.slice('/softn/'.length));
    return file ? send(res, file) : send(res, '');
  }
  const name = p === '/' ? 'index.html' : p.slice(1);
  if (!SITE_FILES.includes(name)) return send(res, '');
  send(res, path.join(here, name));
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use: set HTML_SITE_PORT to another.` : error.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`HTML in SoftN
  as pages of your own site:  http://127.0.0.1:${port}/
  as one bundle:              http://127.0.0.1:${port}/app/`);
});
