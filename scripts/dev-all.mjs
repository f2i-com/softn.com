#!/usr/bin/env node
/**
 * Bring up the four web apps behind one local origin.
 *
 * The site is the public gateway. It serves `/` and the generated guides at
 * `/docs/` itself (scripts/dev-docs.mjs) and proxies `/web/`, `/builder/`,
 * `/studio/` and `/demos/` to three private Vite servers. The
 * browser therefore sees the production path layout during development too.
 * Each process still pins an internal port with `strictPort`; this launcher
 * probes first and moves an occupied preferred port before starting the set.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// The apps import @softn/core, @softn/components and @softn/vite-plugin from
// their dist/ folders, and core's dist carries the ZIPP engine it was built
// with. Without them every Vite server starts and then fails on its first
// import, with a resolution error that names a file rather than the fix — so
// the fix is said before anything starts.
const REQUIRED_BUILDS = [
  'packages/@softn/core/dist/index.js',
  'packages/@softn/core/dist/zipp_wasm_bg.wasm',
  'packages/@softn/components/dist/index.js',
  'packages/@softn/vite-plugin/dist/index.js',
];
const missingBuilds = REQUIRED_BUILDS.filter((file) => !fs.existsSync(path.join(root, file)));
if (missingBuilds.length > 0) {
  console.error(`\n  ${RED}The shared packages are not built yet.${RESET} Missing:`);
  for (const file of missingBuilds) console.error(`    ${file}`);
  console.error(`\n  Run ${YELLOW}npm run build:packages${RESET} once (on a fresh checkout it downloads the ZIPP`);
  console.error(`  engine, so it needs network access), then ${YELLOW}npm run dev${RESET} again. Run it again`);
  console.error(`  after changing packages/@softn/core or packages/@softn/components.\n`);
  process.exit(1);
}

// The demo bundles come from the softn-Examples release they are pinned to;
// bundles already on disk that match their digests are kept without a
// download. Offline on a machine that has never fetched them, the servers can
// still start: /demos/ and the directory's examples are then missing, which is
// said here rather than blocking the rest of the product.
const demos = spawnSync(process.execPath, [path.join(root, 'scripts/fetch-demos.mjs')], { cwd: root, stdio: 'inherit' });
if (demos.status !== 0) {
  console.warn(`\n  ${YELLOW}The demo bundles could not be fetched${RESET} (see above). Starting anyway:`);
  console.warn(`  /demos/ and the directory's examples are missing until ${YELLOW}npm run fetch:demos${RESET} succeeds.\n`);
}

// Vite is run directly rather than through `npm run dev -w …`. Going through npm
// puts a shell and a shim between this process and the server, and on Windows
// killing that shell leaves the real Vite process alive still holding the port —
// so the next `npm run dev` finds every port taken by something invisible.
// Resolved via the package manifest rather than as `vite/bin/vite.js`: Vite's
// `exports` map does not publish its own bin path, so a direct subpath resolve
// throws ERR_PACKAGE_PATH_NOT_EXPORTED.
const vitePkgPath = createRequire(import.meta.url).resolve('vite/package.json');
const viteBin = path.join(path.dirname(vitePkgPath), createRequire(vitePkgPath)('./package.json').bin.vite);

const phpCheck = spawnSync('php', ['-v'], { encoding: 'utf8' });
const havePhp = phpCheck.status === 0;

const APPS = [
  { dir: 'apps/softn-site', label: 'site', port: 1420, base: '/' },
  { dir: 'apps/softn-web', label: 'web', port: 1421, base: '/web/' },
  { dir: 'apps/softn-builder', label: 'builder', port: 1422, base: '/builder/' },
  { dir: 'apps/softn-studio', label: 'studio', port: 1423, base: '/studio/' },
  ...(havePhp ? [{ dir: 'apps/softn-api', label: 'api', port: 1424, isPhp: true }] : []),
];

const COLOURS = { web: '\x1b[36m', site: '\x1b[33m', builder: '\x1b[35m', studio: '\x1b[32m', api: '\x1b[34m' };

/** True if nothing answers on `host:port` within a moment. */
function nothingAnswers(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (free) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

/**
 * Whether an app can have this port.
 *
 * Asking by connecting rather than by binding, because binding does not answer
 * the question on Windows: a server already listening on 127.0.0.1 does not stop
 * a second bind of the wildcard address, so a bind probe cheerfully reports free
 * and every app is then handed a port Vite cannot have — which under strictPort
 * takes the whole set down. Both loopback addresses are checked because
 * `localhost` resolves to either depending on the machine.
 */
async function isFree(port) {
  const [v4, v6] = await Promise.all([nothingAnswers(port, '127.0.0.1'), nothingAnswers(port, '::1')]);
  return v4 && v6;
}

async function claimPort(preferred, taken) {
  for (let port = preferred; port < preferred + 40; port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) {
      taken.add(port);
      return port;
    }
  }
  const holder =
    process.platform === 'win32'
      ? `\`netstat -ano | findstr :${preferred}\` names the process; \`taskkill /pid <pid> /T /F\` ends it`
      : `\`lsof -i :${preferred}\` names the process`;
  throw new Error(`No free port in ${preferred}-${preferred + 39}. Is another \`npm run dev\` still running? ${holder}.`);
}

const taken = new Set();
const resolved = [];
for (const app of APPS) {
  try {
    const port = await claimPort(app.port, taken);
    resolved.push({ ...app, port, preferred: app.port });
  } catch (error) {
    console.error(`\n  ${RED}Cannot start ${app.label}.${RESET} ${error.message}\n`);
    process.exit(1);
  }
}

const urlFor = (label) => `http://localhost:${resolved.find((a) => a.label === label).port}`;
const publicUrl = urlFor('site');

console.log('');
const site = resolved.find((app) => app.label === 'site');
const siteNote =
  site.port !== site.preferred
    ? `${YELLOW}  (${site.preferred} is in use: is another \`npm run dev\` still running?)${RESET}`
    : '';
console.log(`  ${COLOURS.site}softn.com${RESET} ${publicUrl}${siteNote}`);
console.log(`  ${DIM}/web/      runtime`);
console.log(`  /builder/  visual builder`);
console.log(`  /studio/   AI studio`);
console.log(`  /docs/     documentation, rebuilt as it is edited`);
console.log(`  /demos/    app bundles`);
if (havePhp) console.log(`  /api/      directory API${RESET}`);
else {
  console.log(`${RESET}  ${YELLOW}/api/      not started: php is not on PATH${RESET}`);
  console.log(`  ${DIM}           The directory, publishing and server storage need it; the editors and the`);
  console.log(`             runtime do not. Install PHP 8 with pdo_sqlite and zip, then restart.${RESET}`);
}
console.log(`${DIM}  Internal servers: ${resolved
  .filter((app) => app.label !== 'site')
  .map((app) => `${app.label} ${app.port}`)
  .join(', ')}${RESET}`);
console.log('');

const children = [];
let shuttingDown = false;

for (const app of resolved) {
  const isPhp = app.isPhp;
  const child = isPhp
    ? spawn('php', ['-S', `127.0.0.1:${app.port}`, path.join(root, 'apps/softn-api/index.php')], {
        cwd: path.join(root, app.dir),
        env: {
          ...process.env,
          SOFTN_DATA_DIR: path.join(root, 'apps/softn-api/data'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(process.execPath, [viteBin], {
        cwd: path.join(root, app.dir),
        // Browser-facing URLs stay on the gateway; proxy targets are private Vite
        // origins. Production bases also give each HMR socket a distinct route.
        env: {
          ...process.env,
          VITE_PORT: String(app.port),
          VITE_BASE: app.base,
          VITE_WEB_URL: '/web',
          VITE_BUILDER_URL: '/builder',
          VITE_STUDIO_URL: '/studio',
          VITE_WEB_PROXY_TARGET: urlFor('web'),
          VITE_BUILDER_PROXY_TARGET: urlFor('builder'),
          VITE_STUDIO_PROXY_TARGET: urlFor('studio'),
          VITE_API_PROXY_TARGET: resolved.some((a) => a.label === 'api') ? urlFor('api') : undefined,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  const prefix = `${COLOURS[app.label]}${app.label.padEnd(8)}${RESET}`;
  const forward = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix} ${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  // A process that cannot be started at all (php gone from PATH between the
  // probe and the spawn, say) reports here rather than through 'exit'; left
  // unhandled it would crash the launcher and orphan the servers already up.
  child.on('error', (error) => {
    if (shuttingDown) return;
    console.error(`${prefix} could not start: ${error.message}. Stopping the rest.`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${prefix} exited with ${code === null ? `signal ${signal}` : `code ${code}`}. Stopping the rest.`);
    shutdown(code ?? 1);
  });

  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      // Windows has no signal to deliver, and `child.kill()` on a console
      // application there is already a hard terminate — taskkill is the same
      // thing, done synchronously so the process.exit below cannot outrun it.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// Closing the terminal window: SIGHUP on Unix, and on Windows the signal Node
// raises when the console window is closed. Without it the servers outlive the
// window and hold the ports the next `npm run dev` wants.
process.on('SIGHUP', () => shutdown(0));
