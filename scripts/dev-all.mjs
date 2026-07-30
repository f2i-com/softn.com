#!/usr/bin/env node
/**
 * Bring up the four web apps together.
 *
 * Each app pins its own port with `strictPort`, which is the right default —
 * you want to know when something else has your port rather than quietly
 * getting a different one. It is the wrong default for a launcher, because one
 * occupied port would take down the whole set. So this probes first, moves any
 * app whose port is taken to the next free one, and tells the site where the
 * runtime actually ended up, since the site's demo shelf proxies to it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Vite is run directly rather than through `npm run dev -w …`. Going through npm
// puts a shell and a shim between this process and the server, and on Windows
// killing that shell leaves the real Vite process alive still holding the port —
// so the next `npm run dev` finds every port taken by something invisible.
// Resolved via the package manifest rather than as `vite/bin/vite.js`: Vite's
// `exports` map does not publish its own bin path, so a direct subpath resolve
// throws ERR_PACKAGE_PATH_NOT_EXPORTED.
const vitePkgPath = createRequire(import.meta.url).resolve('vite/package.json');
const viteBin = path.join(path.dirname(vitePkgPath), createRequire(vitePkgPath)('./package.json').bin.vite);

const APPS = [
  { dir: 'apps/softn-web', label: 'web', port: 1420 },
  { dir: 'apps/softn-site', label: 'site', port: 1421 },
  { dir: 'apps/softn-builder', label: 'builder', port: 1422 },
  { dir: 'apps/softn-studio', label: 'studio', port: 1423 },
];

const COLOURS = { web: '\x1b[36m', site: '\x1b[33m', builder: '\x1b[35m', studio: '\x1b[32m' };
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

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
  throw new Error(`No free port near ${preferred}.`);
}

const taken = new Set();
const resolved = [];
for (const app of APPS) {
  const port = await claimPort(app.port, taken);
  resolved.push({ ...app, port, preferred: app.port });
}

const urlFor = (label) => `http://localhost:${resolved.find((a) => a.label === label).port}`;

console.log('');
for (const app of resolved) {
  const note = app.port !== app.preferred ? `${DIM}  ${app.preferred} was taken${RESET}` : '';
  console.log(`  ${COLOURS[app.label]}${app.label.padEnd(8)}${RESET} ${urlFor(app.label)}${note}`);
}
console.log('');

const children = [];
let shuttingDown = false;

for (const app of resolved) {
  const child = spawn(process.execPath, [viteBin], {
    cwd: path.join(root, app.dir),
    // Vite reads the port from VITE_PORT in every one of these apps; the site
    // additionally needs to know where to proxy /demos and point its links.
    env: {
      ...process.env,
      VITE_PORT: String(app.port),
      VITE_WEB_URL: urlFor('web'),
      VITE_BUILDER_URL: urlFor('builder'),
      VITE_STUDIO_URL: urlFor('studio'),
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

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`${prefix} exited with code ${code}. Stopping the rest.`);
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
