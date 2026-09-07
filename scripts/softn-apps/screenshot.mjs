#!/usr/bin/env node
/**
 * Photograph every app in the folder so the directory's cards show the app
 * and not its icon: <folder>/thumbs/<Name>.webp, 1280×800.
 *
 *   npm run apps:screenshot [-- --dir <folder>] [--only Name,Name]
 *
 * The apps run in the SoftN web runtime, so the site must be built first —
 * `npm run build:site` writes dist/. This serves that dist/ on a local port
 * with the folder as its /demos/ (the path the runtime opens bundles from),
 * and hands the work to the site's photographer (scripts/screenshot-demos.mjs),
 * which knows how to get past each app's title screen. Headless Edge or
 * Chrome is found on its own; set SOFTN_BROWSER to point at another.
 *
 * No dependencies: Node 22.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dirArg = flag('--dir', process.env.SOFTN_APPS_DIR || '');
const demosDir = dirArg ? path.resolve(process.cwd(), dirArg) : path.join(here, 'apps');
const siteDir = path.resolve(here, '..', '..');
const distDir = path.join(siteDir, 'dist');
const only = flag('--only', '');

if (!fs.existsSync(path.join(demosDir, 'index.json'))) {
  console.error(`${demosDir} has no index.json. Run npm run apps:fetch first.`);
  process.exit(1);
}
const photographer = path.join(siteDir, 'scripts', 'screenshot-demos.mjs');
if (!fs.existsSync(path.join(distDir, 'web', 'index.html'))) {
  console.error(`${distDir} has no built runtime: npm run build:site first.`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.softn': 'application/octet-stream',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** dist/ with the folder as its /demos/: what a deployed site looks like. */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\\/g, '/');
  if (clean.includes('..')) return null;
  const underDemos = /^\/demos(\/|$)/.test(clean);
  const root = underDemos ? demosDir : distDir;
  const rel = underDemos ? clean.replace(/^\/demos\/?/, '') : clean.replace(/^\//, '');
  let file = path.join(root, rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && !underDemos && !path.extname(file)) {
    // The runtime and the site are single-page apps under their own paths.
    const seg = clean.split('/')[1];
    if (['web', 'builder', 'studio'].includes(seg)) file = path.join(distDir, seg, 'index.html');
    else file = path.join(distDir, 'index.html');
  }
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    // The isolation the deployed site's rules give the runtime.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/web`;
console.log(`Serving ${distDir} with ${demosDir} as /demos/ at http://127.0.0.1:${port}/`);

const child = spawn(process.execPath, [photographer, '--dir', demosDir, '--base', base, '--no-api', ...(only ? ['--only', only] : [])], { stdio: 'inherit' });
const code = await new Promise((resolve) => child.on('exit', resolve));
server.close();
const shots = fs.existsSync(path.join(demosDir, 'thumbs')) ? fs.readdirSync(path.join(demosDir, 'thumbs')).filter((f) => /\.(webp|png|jpg)$/i.test(f)).length : 0;
console.log(`\n${shots} screenshots in ${path.join(demosDir, 'thumbs')}`);
process.exit(code ?? 1);
