#!/usr/bin/env node
/**
 * Serve the built deployment the way a host does, for a browser to drive.
 *
 *   node scripts/serve-topology.mjs                 (dist/, a free port)
 *   node scripts/serve-topology.mjs --port 1425
 *   node scripts/serve-topology.mjs --root smoke-root --keep-data
 *
 * The end-to-end gate (e2e/) needs the site, the runtime, Studio, Builder,
 * the play shell and the directory API on ONE origin at their deployed
 * paths: `/`, `/web/`, `/studio/`, `/builder/`, `/play/`, `/api/`. Separate
 * Vite ports are other origins and share no storage, so a hand-off staged
 * by Studio in IndexedDB would never be found by the runtime, and the
 * publish page's keys in localStorage would belong to a different site. So
 * this serves what `build:site` assembled, through PHP's built-in server
 * with the API's router in front of it — the same arrangement the API's
 * README gives for a local preview and scripts/smoke-site.mjs uses for the
 * release check, and the stand-in for the deployed .htaccess.
 *
 * The directory's state goes to a disposable directory (SOFTN_DATA_DIR),
 * created here and removed on exit, so a run starts from an empty catalogue
 * that the API seeds from the example bundles beside it, and dist/ itself is
 * never written to. The build therefore has to carry the examples:
 *
 *   SOFTN_WITH_DEMOS=1 npm run build:site
 *
 * (or `node scripts/build-site.mjs --with-demos`). Without them the
 * directory would be empty and Studio and Builder would have nothing at
 * /demos/ to open, so a root without demos/index.json is refused up front
 * rather than found out one failing test at a time.
 *
 * Needs `php` on PATH with pdo_sqlite and zip. This exits non-zero rather
 * than pretending when it is missing: a gate that silently passes because
 * its server could not start is not a gate.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const root = path.resolve(opt('--root') ?? process.env.SOFTN_TOPOLOGY_ROOT ?? path.join(repoRoot, 'dist'));
const requestedPort = Number(opt('--port') ?? process.env.SOFTN_TOPOLOGY_PORT ?? 0);
const host = opt('--host') ?? '127.0.0.1';
const keepData = args.includes('--keep-data');

function fail(message) {
  console.error(`serve-topology: ${message}`);
  process.exit(1);
}

const REQUIRED = ['index.html', 'web/index.html', 'studio/index.html', 'builder/index.html', 'play/index.html', 'api/index.php', 'api/router.php', 'demos/index.json'];
for (const required of REQUIRED) {
  if (!fs.existsSync(path.join(root, required))) {
    fail(
      `${root} has no ${required}.\n` +
        `  The gate serves the BUILT site with the example bundles in it. Build it first:\n` +
        `    SOFTN_WITH_DEMOS=1 npm run build:site\n` +
        `  (build:packages first on a fresh checkout: the apps import @softn/core and @softn/components from dist/).`
    );
  }
}

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
if (php.status !== 0) fail('php is not on PATH. The topology is served through PHP, as a host serves it.');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = requestedPort > 0 ? requestedPort : await freePort();
const base = `http://${host}:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-topology-'));

// PHP's built-in server answers one request at a time unless told to fork
// workers, and a page of the runtime asks for dozens of chunks at once.
// The worker setting is not honoured on Windows; there the server is simply
// slower, which the gate's timeouts allow for.
const env = { ...process.env, SOFTN_DATA_DIR: dataDir };
if (process.platform !== 'win32' && !env.PHP_CLI_SERVER_WORKERS) env.PHP_CLI_SERVER_WORKERS = '8';

const server = spawn('php', ['-S', `${host}:${port}`, '-t', root, path.join(root, 'api/router.php')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

// The built-in server logs every request on stderr. Only PHP's own
// complaints and the API's are worth a line; the rest is noise a test
// runner would have to scroll past.
const forward = (stream) => {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (/PHP (Warning|Fatal|Parse|Notice|Deprecated)|softn-api:/.test(line) || process.env.SOFTN_TOPOLOGY_VERBOSE === '1') {
        process.stderr.write(`php  ${line}\n`);
      }
    }
  });
};
forward(server.stdout);
forward(server.stderr);

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server.exitCode === null) {
    if (process.platform === 'win32') {
      // No signal to deliver on Windows; taskkill is the hard stop, done
      // synchronously so the exit below cannot outrun it.
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      server.kill();
    }
  }
  if (!keepData) fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  if (!shuttingDown) shutdown(0);
});
server.on('exit', (code) => {
  if (shuttingDown) return;
  console.error(`serve-topology: php exited with code ${code}`);
  shutdown(code ?? 1);
});

async function waitForServer(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok || r.status === 503) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  fail(`the server did not come up on ${base}`);
}

await waitForServer();

// The first listing seeds the directory from demos/; doing it here means
// the first browser page does not pay for it, and a seeding failure is
// reported before any test runs against an empty catalogue.
try {
  const r = await fetch(`${base}/api/apps?perPage=1`);
  const json = await r.json();
  if (!json?.ok) fail(`the directory did not answer its listing: ${JSON.stringify(json).slice(0, 200)}`);
  console.log(`  directory      ${json.total} app${json.total === 1 ? '' : 's'} seeded`);
} catch (err) {
  fail(`the directory could not be seeded: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\n  softn topology  ${base}`);
console.log(`  /               site (directory, /publish, /app/<slug>)`);
console.log(`  /web/           runtime        /studio/   AI studio`);
console.log(`  /builder/       visual builder /play/     play pages`);
console.log(`  /api/           directory API  data: ${dataDir}${keepData ? ' (kept)' : ''}\n`);
