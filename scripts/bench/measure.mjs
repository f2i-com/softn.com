#!/usr/bin/env node
/**
 * Measure what opening a bench fixture costs in a built host.
 *
 *   node scripts/bench/measure.mjs [--host single|web] [--scenario a,b] [--runs N]
 *        [--label name] [--out dir] [--browser path] [--dist dir] [--build]
 *        [--bypass-sw] [--settle ms] [--timeout ms] [--no-runs] [--port N]
 *
 * Serves a production build of the host (apps/softn-single/dist or
 * apps/softn-web/dist, `--build` makes it first) from one local origin with
 * the deployment's isolation and cache headers, zips each scenario from
 * scripts/bench/fixtures/ into a temp dir beside it, and opens the result in
 * headless Edge or Chrome over the DevTools protocol. Every run gets a fresh
 * profile: the first navigation is the cold pass (HTTP cache disabled), the
 * second the warm pass (cache on, and on the web host the service worker
 * installed by the first). --bypass-sw keeps the worker out of the warm pass
 * so HTTP-cache-warm and service-worker-warm can be told apart.
 *
 * Per pass it records every request the page, the service worker and any
 * dedicated worker made (attributed separately, since a precache is traffic
 * the visitor pays for but the first screen did not need), bytes by kind,
 * whether any 3D module was fetched, the `softn:` performance marks paired
 * into phase durations, long tasks, navigation and paint timing, and the
 * moment the fixture's own "ready" sentence appeared. Runs are summarised as
 * median and p90 into <out>/summary.json and summary.md; the default out dir
 * is scripts/bench/results/<label>/, so a label names a measurement and a
 * later one can be diffed against it.
 *
 * No dependencies beyond the workspace: Node's global WebSocket speaks the
 * protocol, fflate (a core dependency) zips the fixtures. Read
 * docs/PERFORMANCE_MEASUREMENT.md before quoting a number from here.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, SCENARIO_NAMES, buildBundle } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

// ── Arguments ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')
    ? args[i + 1]
    : fallback;
};
const has = (name) => args.includes(name);

if (has('--help') || has('-h')) {
  console.log(
    fs
      .readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('*/')[0]
      .replace(/^\/\*\*\n|^ \* ?/gm, '')
  );
  process.exit(0);
}

const HOSTS = {
  single: {
    dist: 'apps/softn-single/dist',
    build: ['npm', ['run', 'build', '-w', '@softn/single']],
    // The single host reads the runtime.config.json beside its index.html, so
    // each scenario gets its own directory on the server and the rest of the
    // path falls through to the one built copy; base is './' so that works.
    url: (origin, scenario) => `${origin}/s/${scenario}/`,
  },
  web: {
    dist: 'apps/softn-web/dist',
    build: ['npm', ['run', 'build', '-w', '@softn/web']],
    // `?open=` accepts a same-origin .softn path; embed=1 drops the launcher
    // chrome the way the directory's cards open an app.
    url: (origin, scenario) =>
      `${origin}/?open=${encodeURIComponent(`/bench/${scenario}.softn`)}&embed=1`,
  },
};

const options = {
  host: flag('--host', 'single'),
  scenarios: flag('--scenario', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  runs: Math.max(1, Number(flag('--runs', '5')) || 5),
  label: flag('--label', 'local'),
  browser: flag('--browser', process.env.SOFTN_BROWSER || ''),
  dist: flag('--dist', ''),
  build: has('--build'),
  bypassServiceWorker: has('--bypass-sw'),
  settleMs: Number(flag('--settle', '1500')) || 1500,
  timeoutMs: Number(flag('--timeout', '60000')) || 60000,
  writeRuns: !has('--no-runs'),
  port: Number(flag('--port', '0')) || 0,
  // How long the service worker has to go quiet before its precache is called
  // complete; the cap keeps a worker that never settles from stalling a run.
  swQuietMs: 1500,
  swQuietCapMs: 20000,
};
if (!HOSTS[options.host]) {
  console.error(`Unknown host "${options.host}": single or web.`);
  process.exit(1);
}
if (options.scenarios.length === 0) options.scenarios = SCENARIO_NAMES;
for (const name of options.scenarios) {
  if (!SCENARIOS[name]) {
    console.error(`Unknown scenario "${name}". Known: ${SCENARIO_NAMES.join(', ')}`);
    process.exit(1);
  }
}
const outDir = path.resolve(flag('--out', path.join(here, 'results', options.label)));

/** Chunk names are hashed and lower-case; the feature names inside them are not. */
const HEAVY_URL = /three|scene3d|gltf|objloader|fbx|stl|postprocessing|bloom/i;

/**
 * The same question asked of the bytes rather than the file name. A host
 * that bundles Three into its entry chunk shows nothing in a URL; these
 * strings are the library's own warning prefixes and render-target names,
 * which minification keeps.
 *
 * Not the class names for the post-processing pair: since the addons became
 * chunks of their own, the scene3d chunk names them — `import("./
 * EffectComposer-<hash>.js")`, `mod.UnrealBloomPass` — without containing
 * them, and a scene without effects was reported as carrying bloom. The
 * strings below are what the modules write into their own render targets'
 * `texture.name` (`'EffectComposer.rt1'`, `'UnrealBloomPass.h' + i`), so
 * they occur in the addon's body and nowhere else.
 */
const HEAVY_CODE = {
  three: /THREE\.WebGLRenderer/,
  gltf: /THREE\.GLTFLoader/,
  obj: /THREE\.OBJLoader/,
  fbx: /THREE\.FBXLoader/,
  stl: /THREE\.STLLoader/,
  postprocessing: /EffectComposer\.rt1/,
  bloom: /UnrealBloomPass\.[hv]/,
};

// ── Browser discovery ────────────────────────────────────────────────

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findBrowser() {
  if (options.browser) {
    if (fs.existsSync(options.browser)) return options.browser;
    throw new Error(`No browser at ${options.browser}`);
  }
  const found = BROWSERS.find((p) => fs.existsSync(p));
  if (!found)
    throw new Error('No Chromium-based browser found; pass --browser or set SOFTN_BROWSER.');
  return found;
}

// ── Static server ────────────────────────────────────────────────────

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
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

/**
 * The same buckets scripts/build-site.mjs writes into .htaccess: hashed assets
 * immutable, other static files an hour, documents, JSON, workers and bundles
 * revalidated. The warm pass measures against these, so a server that said
 * no-cache for everything would report a warm visit that re-fetches the world.
 */
function cacheControl(file) {
  const base = path.basename(file);
  if (/^(?:registerSW|sw|service-worker)\.js$/.test(base))
    return 'no-cache, max-age=0, must-revalidate';
  if (/\.(?:html?|json|webmanifest|softn)$/.test(base))
    return 'no-cache, max-age=0, must-revalidate';
  if (/-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|map|wasm|woff2?|ttf|png|jpe?g|gif|webp|svg)$/.test(base)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

function baseHeaders(file, length) {
  return {
    'Cache-Control': cacheControl(file),
    'Content-Length': length,
    'Content-Type': MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
    // The runtime needs SharedArrayBuffer and a worker-mode app needs the
    // embedder policy on every response, exactly as the deployment sends it.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
  };
}

function startServer({ host, distDir, bundles }) {
  const configFor = (name) =>
    JSON.stringify({
      version: 1,
      id: `bench-${name}`,
      title: `Bench ${name}`,
      bundle: './app.softn',
      loadingText: 'Loading…',
      theme: 'dark',
    });

  /** Map a request path to { file } on disk or { body, name } in memory. */
  function resolve(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('..')) return null;
    let rest = decoded;
    if (host === 'single') {
      const m = /^\/s\/([a-z0-9-]+)\/(.*)$/.exec(decoded);
      if (!m || !bundles.has(m[1])) return null;
      if (m[2] === 'runtime.config.json')
        return { body: Buffer.from(configFor(m[1])), name: 'runtime.config.json' };
      if (m[2] === 'app.softn')
        return { body: Buffer.from(bundles.get(m[1]).bytes), name: 'app.softn' };
      rest = `/${m[2]}`;
    } else {
      const m = /^\/bench\/([a-z0-9-]+)\.softn$/.exec(decoded);
      if (m)
        return bundles.has(m[1])
          ? { body: Buffer.from(bundles.get(m[1]).bytes), name: `${m[1]}.softn` }
          : null;
    }
    const candidate = path.resolve(distDir, rest.replace(/^\/+/, ''));
    if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) return null;
    let file = candidate;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    // A single-page host answers any extension-less path with its shell.
    if (!fs.existsSync(file) && !/\.[^/]+$/.test(rest)) file = path.join(distDir, 'index.html');
    return fs.existsSync(file) && fs.statSync(file).isFile() ? { file } : null;
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const hit = resolve(url.pathname);
    if (!hit) {
      const body = 'Not found\n';
      res.writeHead(404, baseHeaders('x.txt', Buffer.byteLength(body)));
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (hit.body) {
      res.writeHead(200, baseHeaders(hit.name, hit.body.length));
      res.end(req.method === 'HEAD' ? undefined : hit.body);
      return;
    }
    const stat = fs.statSync(hit.file);
    res.writeHead(200, baseHeaders(hit.file, stat.size));
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(hit.file).pipe(res);
  });

  return new Promise((resolveServer, reject) => {
    server.on('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ── DevTools protocol ────────────────────────────────────────────────

/**
 * One socket to the browser; every page, worker and service worker is a
 * flattened session on it, addressed by sessionId. Events are delivered with
 * the session they came from so requests can be attributed.
 */
/**
 * How long one protocol call may go unanswered. A wedged renderer answers
 * nothing at all, and a promise nobody settles would hold the ready loop past
 * --timeout; the loop tolerates a rejected evaluate, so the call is dropped
 * with an error naming the method instead. Generous, because a single
 * Runtime.evaluate legitimately waits on a page that is loading a scene.
 */
const CDP_SEND_TIMEOUT_MS = 60_000;
/** How long the debugging socket may take to open before the launch is abandoned. */
const CDP_CONNECT_TIMEOUT_MS = 15_000;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    const settle = (mid) => {
      const entry = pending.get(mid);
      if (entry) {
        pending.delete(mid);
        clearTimeout(entry.timer);
      }
      return entry;
    };
    // A socket that neither opens nor errors — the browser died between
    // /json/version and here — would otherwise hang the launch for good.
    const opening = setTimeout(() => {
      reject(new Error(`The debugging socket did not open within ${CDP_CONNECT_TIMEOUT_MS} ms`));
      ws.close();
    }, CDP_CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(opening);
      resolve({
        send(method, params = {}, sessionId, timeoutMs = CDP_SEND_TIMEOUT_MS) {
          const mid = ++id;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              if (settle(mid)) rej(new Error(`${method}: no answer after ${timeoutMs} ms`));
            }, timeoutMs);
            // Unreferenced so a call still waiting cannot keep the process
            // alive once the socket has closed and rejected it.
            timer.unref?.();
            pending.set(mid, { res, rej, method, timer });
            ws.send(
              JSON.stringify(
                sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }
              )
            );
          });
        },
        on(method, fn) {
          handlers.set(method, fn);
        },
        close() {
          ws.close();
        },
      });
    };
    ws.onerror = (e) => {
      clearTimeout(opening);
      reject(new Error(`WebSocket error: ${e.message ?? e.type}`));
    };
    ws.onclose = () => {
      clearTimeout(opening);
      for (const { rej, method, timer } of pending.values()) {
        clearTimeout(timer);
        rej(new Error(`Browser closed during ${method}`));
      }
      pending.clear();
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, method } = settle(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method && handlers.has(msg.method)) {
        handlers.get(msg.method)(msg.params, msg.sessionId);
      }
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** SOFTN_BENCH_DEBUG=1 narrates the protocol: which targets attached, what each answered. */
const debug = process.env.SOFTN_BENCH_DEBUG
  ? (line) => console.error(`  [debug] ${line}`)
  : () => {};

async function launch(browser, profile) {
  const proc = spawn(
    browser,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      // Nothing of the browser's own on the wire or the CPU while a run is
      // timed: update checks, sync, extensions and the like.
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      // Software WebGL. A headless run has no GPU; without these flags the
      // context fails and every scene scenario measures an error card.
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  // The port is written to the profile once the browser is listening.
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 200 && !port; i++) {
    try {
      const [line] = fs.readFileSync(portFile, 'utf8').split('\n');
      port = Number(line) || 0;
    } catch {
      await sleep(100);
    }
  }
  if (!port) {
    proc.kill();
    throw new Error('The browser did not start');
  }
  let info = null;
  for (let i = 0; i < 50 && !info; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  if (!info) {
    proc.kill();
    throw new Error('The browser did not answer on its debugging port');
  }
  let cdp;
  try {
    cdp = await connect(info.webSocketDebuggerUrl);
  } catch (err) {
    // The caller's finally never runs — it has no browser handle to close yet
    // — so a socket that failed to open would leave headless Edge running on
    // its temp profile, like the two failures above would have.
    proc.kill();
    throw err;
  }
  return {
    cdp,
    version: info.Browser,
    async close() {
      try {
        // A short budget: the browser is being killed next in any case.
        await cdp.send('Browser.close', {}, undefined, 2000);
      } catch {
        // Already gone.
      }
      cdp.close();
      proc.kill();
      // The browser lets go of its profile a beat after it exits.
      await sleep(800);
    },
  };
}

// ── In-page instrumentation ──────────────────────────────────────────

/**
 * Installed before any document script runs. Collects long tasks, the first
 * WebGL context and draw call, the first moment the scenario's ready
 * expression holds, and uncaught errors, all on window.__softnBench.
 */
function instrumentation(readyExpr) {
  return `(() => {
  const bench = { longTasks: [], readyAt: null, webgl: { contextAt: null, firstDrawAt: null }, errors: 0 };
  window.__softnBench = bench;
  // The page's text as a reader would see it, without the layout innerText
  // forces: textContent alone would include the theme's injected stylesheet.
  bench.text = () => {
    if (!document.body) return '';
    const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && skip.has(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let out = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out += n.nodeValue + ' ';
    return out;
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) bench.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* no long task timing in this browser */ }
  const proto = HTMLCanvasElement.prototype;
  const getContext = proto.getContext;
  proto.getContext = function (type, ...rest) {
    const ctx = getContext.call(this, type, ...rest);
    if (ctx && /webgl/i.test(String(type)) && bench.webgl.contextAt === null) bench.webgl.contextAt = performance.now();
    return ctx;
  };
  // The draw hooks unhook themselves after the first call: a wrapper on every
  // draw for the life of the page would be the harness in the measurement.
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const originals = {};
    const restore = () => { for (const m of Object.keys(originals)) C.prototype[m] = originals[m]; };
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const o = C.prototype[m];
      if (typeof o !== 'function') continue;
      originals[m] = o;
      C.prototype[m] = function (...a) {
        if (bench.webgl.firstDrawAt === null) bench.webgl.firstDrawAt = performance.now();
        restore();
        return o.apply(this, a);
      };
    }
  }
  const ready = () => { try { return !!(${readyExpr}); } catch (e) { return false; } };
  const check = () => { if (bench.readyAt === null && ready()) bench.readyAt = performance.now(); };
  const start = () => {
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    check();
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  window.addEventListener('error', () => { bench.errors++; });
})();`;
}

const COLLECT = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = {};
  for (const p of performance.getEntriesByType('paint')) paint[p.name] = p.startTime;
  const marks = performance.getEntriesByType('mark').filter((m) => m.name.startsWith('softn:')).map((m) => ({ name: m.name, at: m.startTime }));
  const measures = performance.getEntriesByType('measure').filter((m) => m.name.startsWith('softn:')).map((m) => ({ name: m.name, at: m.startTime, duration: m.duration }));
  const bench = window.__softnBench || null;
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlled' : 'none';
  return {
    nav: nav ? { responseEnd: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd, loadEventEnd: nav.loadEventEnd, domInteractive: nav.domInteractive } : null,
    paint, marks, measures, bench, sw,
    canvases: document.querySelectorAll('canvas').length,
    text: (bench ? bench.text() : '').replace(/\\s+/g, ' ').trim().slice(0, 240),
  };
})()`;

// A context of its own, asked for after everything else has been collected,
// so the probe is not the first context the page saw.
const WEBGL_PROBE = `(() => {
  const c = document.createElement('canvas');
  let webgl2 = false, webgl1 = false, renderer = null;
  try { const gl = c.getContext('webgl2'); webgl2 = !!gl; if (gl) { const d = gl.getExtension('WEBGL_debug_renderer_info'); renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } } catch (e) { /* unavailable */ }
  try { webgl1 = !!document.createElement('canvas').getContext('webgl'); } catch (e) { /* unavailable */ }
  return { webgl2, webgl1, renderer };
})()`;

// ── One run: cold pass, then warm pass, in a fresh profile ───────────

function classify(url, type) {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  // A bundled asset reaches a component as an object URL; the model load
  // shows up here as a fetch of one.
  if (url.startsWith('blob:')) return 'blob';
  if (/\.softn$/i.test(pathname)) return 'bundle';
  if (/\.wasm$/i.test(pathname)) return 'wasm';
  if (type === 'Script' || /\.m?js$/i.test(pathname)) return 'js';
  if (type === 'Stylesheet' || /\.css$/i.test(pathname)) return 'css';
  if (type === 'Document' || /\.html?$/i.test(pathname) || pathname.endsWith('/')) return 'html';
  if (/\.(?:json|webmanifest)$/i.test(pathname)) return 'json';
  if (type === 'Font' || /\.(?:woff2?|ttf|otf)$/i.test(pathname)) return 'font';
  if (type === 'Image' || /\.(?:png|jpe?g|gif|webp|svg|ico)$/i.test(pathname)) return 'image';
  return 'other';
}

/**
 * Whether a URL names a 3D module. Tested on the file name with Vite's hash
 * segment removed and only for code-shaped kinds: eight base64 characters
 * spell "stl" or "obj" often enough that a font file was the first match.
 */
function isHeavyUrl(r) {
  if (!['js', 'wasm', 'other'].includes(r.kind)) return false;
  let name = r.url;
  try {
    name = new URL(r.url).pathname;
  } catch {
    // Not a URL; test the string as it is.
  }
  return HEAVY_URL.test(name.replace(/-[A-Za-z0-9_-]{8,}(?=\.[a-z0-9]+$)/i, ''));
}

function summariseRequests(list, origin) {
  const short = (url) => (url.startsWith(origin) ? url.slice(origin.length) : url);
  const page = list.filter((r) => r.context === 'page');
  const sum = (rows, pick) => rows.reduce((n, r) => n + (pick(r) || 0), 0);
  // Wire bytes are what this visit transferred; content bytes are the size
  // of everything it loaded whether or not a cache answered, which is what a
  // visitor with an empty cache would pay for the same list.
  const tally = (rows) => ({
    requests: rows.length,
    bytes: sum(rows, (r) => r.bytes),
    contentBytes: sum(rows, (r) => r.contentLength),
  });
  const byKind = {};
  for (const r of page) {
    const k = (byKind[r.kind] ||= { requests: 0, bytes: 0, contentBytes: 0 });
    k.requests++;
    k.bytes += r.bytes || 0;
    k.contentBytes += r.contentLength || 0;
  }
  const sw = list.filter((r) => r.context === 'serviceWorker');
  const worker = list.filter((r) => r.context === 'worker');
  const heavyUrls = [...new Set([...page, ...worker].filter(isHeavyUrl).map((r) => short(r.url)))];
  return {
    ...tally(page),
    jsBytes: byKind.js?.bytes ?? 0,
    wasmBytes: byKind.wasm?.bytes ?? 0,
    cssBytes: byKind.css?.bytes ?? 0,
    bundleBytes: byKind.bundle?.bytes ?? 0,
    byKind,
    fromCache: page.filter((r) => r.fromDiskCache || r.fromMemoryCache).length,
    fromServiceWorker: page.filter((r) => r.fromServiceWorker).length,
    failed: page.filter((r) => r.failed).length,
    serviceWorker: {
      ...tally(sw),
      fromCache: sw.filter((r) => r.fromDiskCache || r.fromMemoryCache).length,
      heavyUrls: [...new Set(sw.filter(isHeavyUrl).map((r) => short(r.url)))],
    },
    worker: tally(worker),
    heavyFeatureRequested: heavyUrls.length > 0,
    heavyUrls,
  };
}

/** Pair softn:<phase>:start with the first softn:<phase>:end after it. */
function pairMarks(marks, measures) {
  const durations = {};
  const points = {};
  const unpaired = [];
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const used = new Set();
  for (const m of sorted) {
    if (m.name.endsWith(':start')) {
      const phase = m.name.slice(0, -':start'.length);
      const end = sorted.find((e) => !used.has(e) && e.name === `${phase}:end` && e.at >= m.at);
      if (end) {
        used.add(end);
        // A phase that runs more than once keeps its first duration and the total.
        if (durations[phase] === undefined) durations[phase] = end.at - m.at;
        else durations[phase] += end.at - m.at;
      } else unpaired.push(m.name);
    } else if (!m.name.endsWith(':end')) {
      if (points[m.name] === undefined) points[m.name] = m.at;
    } else if (!used.has(m)) {
      const phase = m.name.slice(0, -':end'.length);
      if (!sorted.some((s) => s.name === `${phase}:start` && s.at <= m.at)) unpaired.push(m.name);
    }
  }
  for (const m of measures) {
    if (durations[m.name] === undefined) durations[m.name] = m.duration;
    else durations[m.name] += m.duration;
  }
  return { durations, points, unpaired };
}

async function runOnce({ browser, url, scenario, origin, log }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-bench-'));
  const b = await launch(browser, profile);
  const { cdp } = b;
  const sessions = new Map();
  let pageSession = null;
  let requests = new Map();
  let lastServiceWorkerActivity = 0;
  const consoleErrors = [];
  let exceptions = 0;
  const signatureByUrl = new Map();

  const contextOf = (sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) return 'page';
    if (s.type === 'service_worker') return 'serviceWorker';
    if (s.type === 'worker' || s.type === 'shared_worker') return 'worker';
    return 'page';
  };

  cdp.on('Network.requestWillBeSent', (p, sessionId) => {
    if (p.request.url.startsWith('data:')) return;
    const context = contextOf(sessionId);
    if (context === 'serviceWorker') lastServiceWorkerActivity = Date.now();
    requests.set(`${sessionId}:${p.requestId}`, {
      sessionId,
      requestId: p.requestId,
      url: p.request.url,
      type: p.type,
      kind: classify(p.request.url, p.type),
      context,
      startedAt: p.timestamp,
      status: null,
      bytes: 0,
      fromDiskCache: false,
      fromMemoryCache: false,
      fromServiceWorker: false,
      failed: false,
    });
  });
  cdp.on('Network.responseReceived', (p, sessionId) => {
    const r = requests.get(`${sessionId}:${p.requestId}`);
    if (!r) return;
    r.status = p.response.status;
    r.mimeType = p.response.mimeType;
    r.fromDiskCache = !!p.response.fromDiskCache;
    r.fromServiceWorker = !!p.response.fromServiceWorker;
    r.protocol = p.response.protocol;
    const length = p.response.headers?.['content-length'] ?? p.response.headers?.['Content-Length'];
    if (length !== undefined) r.contentLength = Number(length);
  });
  cdp.on('Network.requestServedFromCache', (p, sessionId) => {
    const r = requests.get(`${sessionId}:${p.requestId}`);
    if (r) r.fromMemoryCache = true;
  });
  cdp.on('Network.loadingFinished', (p, sessionId) => {
    const r = requests.get(`${sessionId}:${p.requestId}`);
    if (!r) return;
    r.bytes = p.encodedDataLength;
    r.finishedAt = p.timestamp;
    if (r.context === 'serviceWorker') lastServiceWorkerActivity = Date.now();
  });
  cdp.on('Network.loadingFailed', (p, sessionId) => {
    const r = requests.get(`${sessionId}:${p.requestId}`);
    if (!r) return;
    r.failed = true;
    r.error = p.errorText;
  });
  cdp.on('Runtime.exceptionThrown', (p, sessionId) => {
    if (sessionId !== pageSession) return;
    exceptions++;
    const text = p.exceptionDetails.exception?.description ?? p.exceptionDetails.text ?? '';
    if (consoleErrors.length < 5) consoleErrors.push(text.split('\n')[0].slice(0, 200));
  });
  cdp.on('Runtime.consoleAPICalled', (p, sessionId) => {
    if (sessionId !== pageSession || p.type !== 'error') return;
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (consoleErrors.length < 5) consoleErrors.push(text.slice(0, 200));
  });

  // Every target the browser attaches — the page created below, the service
  // worker it registers, dedicated workers — is paused until this handler has
  // switched its Network domain on, so no request escapes attribution.
  const attached = new Map();
  const attachWaiters = new Map();
  cdp.on('Target.attachedToTarget', (p) => {
    const { sessionId, targetInfo } = p;
    const isWorker =
      targetInfo.type === 'service_worker' ||
      targetInfo.type === 'worker' ||
      targetInfo.type === 'shared_worker';
    // The browser-level auto-attach and the page-level one both report the
    // page's service worker, as two sessions on one target. Only the first
    // gets a Network domain, or every worker request would be counted twice.
    const duplicate = attached.has(targetInfo.targetId);
    debug(
      `attached ${targetInfo.type} ${targetInfo.url}${p.waitingForDebugger ? ' (paused)' : ''}${duplicate ? ' (again)' : ''}`
    );
    if (!duplicate) {
      attached.set(targetInfo.targetId, sessionId);
      sessions.set(sessionId, {
        type: targetInfo.type,
        url: targetInfo.url,
        targetId: targetInfo.targetId,
      });
      if (isWorker) {
        // Not awaited: a paused worker answers nothing until it is resumed,
        // but it processes what arrived before the resume, in order.
        cdp
          .send('Network.enable', {}, sessionId)
          .catch((err) => debug(`Network.enable on ${targetInfo.type}: ${err.message}`));
        // Workers can spawn workers.
        cdp
          .send(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
            sessionId
          )
          .catch((err) => debug(`setAutoAttach on ${targetInfo.type}: ${err.message}`));
      }
    }
    if (p.waitingForDebugger && (isWorker || duplicate)) {
      cdp
        .send('Runtime.runIfWaitingForDebugger', {}, sessionId)
        .catch((err) => debug(`resume ${targetInfo.type}: ${err.message}`));
    }
    const waiter = attachWaiters.get(targetInfo.targetId);
    if (waiter) waiter({ sessionId, waitingForDebugger: p.waitingForDebugger });
  });
  cdp.on('Target.detachedFromTarget', (p) => {
    sessions.delete(p.sessionId);
  });

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      pageSession
    );
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  const pass = async (name) => {
    requests = new Map();
    consoleErrors.length = 0;
    exceptions = 0;
    const wall0 = Date.now();
    await cdp.send('Page.navigate', { url }, pageSession);
    let readyAt = null;
    let timedOut = false;
    for (;;) {
      await sleep(100);
      try {
        readyAt = await evaluate('window.__softnBench ? window.__softnBench.readyAt : null');
      } catch {
        readyAt = null;
      }
      if (readyAt !== null) break;
      if (Date.now() - wall0 > options.timeoutMs) {
        timedOut = true;
        break;
      }
    }
    await sleep(options.settleMs);
    const collected = await evaluate(COLLECT);
    const metrics = await cdp
      .send('Performance.getMetrics', {}, pageSession)
      .catch(() => ({ metrics: [] }));
    const perf = Object.fromEntries(metrics.metrics.map((m) => [m.name, m.value]));
    const webgl = await evaluate(WEBGL_PROBE).catch(() => ({
      webgl2: false,
      webgl1: false,
      renderer: null,
    }));

    // The page has what it needs; what the service worker goes on to fetch
    // afterwards is the precache, reported apart from the first screen.
    const untilReady = summariseRequests([...requests.values()], origin);
    const quietStart = Date.now();
    while (Date.now() - quietStart < options.swQuietCapMs) {
      const swActive = [...requests.values()].some(
        (r) => r.context === 'serviceWorker' && !r.finishedAt && !r.failed
      );
      if (
        !swActive &&
        Date.now() - Math.max(lastServiceWorkerActivity, quietStart) >= options.swQuietMs
      )
        break;
      await sleep(200);
    }
    const list = [...requests.values()].sort((a, b) => a.startedAt - b.startedAt);
    const totals = summariseRequests(list, origin);
    // What each loaded script contains, remembered by URL: a warm pass whose
    // chunks came out of memory has no body to read back and inherits the
    // cold pass's answer for the same file.
    for (const r of list) {
      if (r.kind !== 'js' || r.context === 'serviceWorker' || r.failed || signatureByUrl.has(r.url))
        continue;
      try {
        const { body, base64Encoded } = await cdp.send(
          'Network.getResponseBody',
          { requestId: r.requestId },
          r.sessionId
        );
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        signatureByUrl.set(
          r.url,
          Object.keys(HEAVY_CODE).filter((k) => HEAVY_CODE[k].test(text))
        );
      } catch (err) {
        debug(`getResponseBody ${r.url}: ${err.message}`);
      }
    }
    const heavyCode = {};
    for (const r of list) {
      if (r.kind !== 'js' || r.context === 'serviceWorker') continue;
      for (const feature of signatureByUrl.get(r.url) ?? []) {
        const urls = (heavyCode[feature] ||= []);
        const short = r.url.startsWith(origin) ? r.url.slice(origin.length) : r.url;
        if (!urls.includes(short)) urls.push(short);
      }
    }
    const heavyCodeLoaded = Object.keys(heavyCode).length > 0;
    const bench = collected.bench || { longTasks: [], readyAt: null, webgl: {}, errors: 0 };
    const longTasks = bench.longTasks.filter(
      (t) => readyAt === null || t.start <= readyAt + options.settleMs
    );
    const marks = pairMarks(collected.marks, collected.measures);
    log(
      `${name.padEnd(5)} ${readyAt === null ? 'not ready' : `ready ${Math.round(readyAt)} ms`}` +
        ` · ${totals.requests} req · ${(totals.bytes / 1024).toFixed(0)} KB` +
        (totals.serviceWorker.requests
          ? ` · sw ${totals.serviceWorker.requests} req ${(totals.serviceWorker.bytes / 1024).toFixed(0)} KB`
          : '') +
        ` · long tasks ${longTasks.length}` +
        (totals.heavyFeatureRequested ? ' · 3D module URL fetched' : '') +
        (heavyCodeLoaded ? ` · 3D code in loaded JS (${Object.keys(heavyCode).join(',')})` : '') +
        (timedOut ? ' · TIMED OUT' : '')
    );
    return {
      pass: name,
      ready: readyAt !== null,
      readyMs: readyAt,
      timedOut,
      nav: collected.nav,
      paint: {
        firstPaint: collected.paint['first-paint'] ?? null,
        firstContentfulPaint: collected.paint['first-contentful-paint'] ?? null,
      },
      webgl: {
        available: webgl.webgl2 || webgl.webgl1,
        webgl2: webgl.webgl2,
        renderer: webgl.renderer,
        contextAt: bench.webgl.contextAt ?? null,
        firstDrawAt: bench.webgl.firstDrawAt ?? null,
      },
      canvases: collected.canvases,
      serviceWorkerControlled: collected.sw === 'controlled',
      totals,
      heavyCode,
      heavyCodeLoaded,
      untilReady: {
        requests: untilReady.requests,
        bytes: untilReady.bytes,
        contentBytes: untilReady.contentBytes,
        serviceWorker: untilReady.serviceWorker,
      },
      marks,
      longTasks: {
        count: longTasks.length,
        totalMs: longTasks.reduce((n, t) => n + t.duration, 0),
        maxMs: longTasks.reduce((n, t) => Math.max(n, t.duration), 0),
      },
      performance: {
        scriptMs: (perf.ScriptDuration ?? 0) * 1000,
        taskMs: (perf.TaskDuration ?? 0) * 1000,
        layoutMs: (perf.LayoutDuration ?? 0) * 1000,
        jsHeapUsedMb: (perf.JSHeapUsedSize ?? 0) / (1024 * 1024),
        domNodes: perf.Nodes ?? null,
      },
      errors: { uncaught: bench.errors + exceptions, console: consoleErrors.slice() },
      textSample: collected.text,
      requests: list.map((r) => ({
        url: r.url.startsWith(origin) ? r.url.slice(origin.length) : r.url,
        kind: r.kind,
        type: r.type,
        context: r.context,
        status: r.status,
        bytes: r.bytes,
        contentLength: r.contentLength ?? null,
        fromDiskCache: r.fromDiskCache,
        fromMemoryCache: r.fromMemoryCache,
        fromServiceWorker: r.fromServiceWorker,
        failed: r.failed,
        error: r.error,
      })),
    };
  };

  try {
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    // The attach event may have arrived before createTarget answered.
    pageSession =
      attached.get(targetId) ??
      (await new Promise((r) => attachWaiters.set(targetId, r))).sessionId;
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Runtime.enable', {}, pageSession);
    // Bodies are read back after each pass to look for 3D code inside
    // chunks, so the buffer has to hold every script the page loaded.
    await cdp.send(
      'Network.enable',
      { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 50 * 1024 * 1024 },
      pageSession
    );
    await cdp.send('Performance.enable', {}, pageSession);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      pageSession
    );
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: instrumentation(scenario.ready) },
      pageSession
    );
    await cdp.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      pageSession
    );
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, pageSession).catch(() => {});

    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, pageSession);
    const cold = await pass('cold');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }, pageSession);
    if (options.bypassServiceWorker)
      await cdp.send('Network.setBypassServiceWorker', { bypass: true }, pageSession);
    const warm = await pass('warm');
    return { cold, warm, browser: b.version };
  } finally {
    await b.close();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // A stray temp profile is not worth failing the run over.
    }
  }
}

// ── Statistics and reporting ─────────────────────────────────────────

function quantile(values, q) {
  const xs = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  // Nearest rank, so a p90 of five runs is a run that happened, not an interpolation.
  const rank = Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1));
  return xs[rank];
}

function stats(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return null;
  return {
    median: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    min: Math.min(...xs),
    max: Math.max(...xs),
    n: xs.length,
  };
}

/** The scalar view of one pass: what summary.json keeps for every run. */
function scalars(p) {
  const out = {
    ready: p.ready,
    timedOut: p.timedOut,
    readyMs: p.readyMs,
    firstPaintMs: p.paint.firstPaint,
    firstContentfulPaintMs: p.paint.firstContentfulPaint,
    responseEndMs: p.nav?.responseEnd ?? null,
    domContentLoadedMs: p.nav?.domContentLoaded ?? null,
    loadEventEndMs: p.nav?.loadEventEnd ?? null,
    webglContextAtMs: p.webgl.contextAt,
    firstDrawAtMs: p.webgl.firstDrawAt,
    requests: p.totals.requests,
    bytes: p.totals.bytes,
    contentBytes: p.totals.contentBytes,
    jsBytes: p.totals.jsBytes,
    wasmBytes: p.totals.wasmBytes,
    cssBytes: p.totals.cssBytes,
    bundleBytes: p.totals.bundleBytes,
    fromCache: p.totals.fromCache,
    fromServiceWorker: p.totals.fromServiceWorker,
    failedRequests: p.totals.failed,
    requestsUntilReady: p.untilReady.requests,
    bytesUntilReady: p.untilReady.bytes,
    serviceWorkerRequests: p.totals.serviceWorker.requests,
    serviceWorkerBytes: p.totals.serviceWorker.bytes,
    serviceWorkerContentBytes: p.totals.serviceWorker.contentBytes,
    serviceWorkerFromCache: p.totals.serviceWorker.fromCache,
    serviceWorkerBytesUntilReady: p.untilReady.serviceWorker.bytes,
    workerRequests: p.totals.worker.requests,
    workerBytes: p.totals.worker.bytes,
    workerContentBytes: p.totals.worker.contentBytes,
    heavyFeatureRequested: p.totals.heavyFeatureRequested,
    heavyFeaturePrecached: p.totals.serviceWorker.heavyUrls.length > 0,
    heavyCodeLoaded: p.heavyCodeLoaded,
    webglAvailable: p.webgl.available,
    serviceWorkerControlled: p.serviceWorkerControlled,
    longTasks: p.longTasks.count,
    longTaskMs: p.longTasks.totalMs,
    longTaskMaxMs: p.longTasks.maxMs,
    scriptMs: p.performance.scriptMs,
    taskMs: p.performance.taskMs,
    jsHeapUsedMb: p.performance.jsHeapUsedMb,
    uncaughtErrors: p.errors.uncaught,
    marks: p.marks.durations,
    markPoints: p.marks.points,
  };
  return out;
}

const NUMERIC = [
  ['readyMs', 'app ready (ms)'],
  ['firstPaintMs', 'first paint (ms)'],
  ['firstContentfulPaintMs', 'first contentful paint (ms)'],
  ['responseEndMs', 'document responseEnd (ms)'],
  ['domContentLoadedMs', 'DOMContentLoaded (ms)'],
  ['loadEventEndMs', 'load event end (ms)'],
  ['webglContextAtMs', 'first WebGL context (ms)'],
  ['firstDrawAtMs', 'first GL draw (ms)'],
  ['requests', 'page requests'],
  ['bytes', 'page bytes on the wire'],
  ['contentBytes', 'page bytes loaded (content-length, cached or not)'],
  ['jsBytes', 'JS bytes'],
  ['wasmBytes', 'wasm bytes'],
  ['cssBytes', 'CSS bytes'],
  ['bundleBytes', 'bundle bytes'],
  ['fromCache', 'requests from HTTP cache'],
  ['fromServiceWorker', 'requests from service worker'],
  ['failedRequests', 'failed requests'],
  ['requestsUntilReady', 'page requests until ready'],
  ['bytesUntilReady', 'page bytes until ready'],
  ['serviceWorkerRequests', 'service worker requests'],
  ['serviceWorkerBytes', 'service worker bytes on the wire'],
  ['serviceWorkerContentBytes', 'service worker bytes loaded (content-length)'],
  ['serviceWorkerFromCache', 'service worker requests from HTTP cache'],
  ['serviceWorkerBytesUntilReady', 'service worker bytes on the wire until ready'],
  ['workerRequests', 'dedicated worker requests'],
  ['workerBytes', 'dedicated worker bytes on the wire'],
  ['workerContentBytes', 'dedicated worker bytes loaded (content-length)'],
  ['longTasks', 'long tasks'],
  ['longTaskMs', 'long task total (ms)'],
  ['longTaskMaxMs', 'longest task (ms)'],
  ['scriptMs', 'script time (ms)'],
  ['taskMs', 'main-thread task time (ms)'],
  ['jsHeapUsedMb', 'JS heap used (MB)'],
  ['uncaughtErrors', 'uncaught errors'],
];

function aggregate(passes) {
  const rows = passes.map(scalars);
  const metrics = {};
  for (const [key] of NUMERIC) metrics[key] = stats(rows.map((r) => r[key]));
  const markNames = [...new Set(rows.flatMap((r) => Object.keys(r.marks)))].sort();
  const marks = {};
  for (const name of markNames) marks[name] = stats(rows.map((r) => r.marks[name]));
  const pointNames = [...new Set(rows.flatMap((r) => Object.keys(r.markPoints)))].sort();
  const markPoints = {};
  for (const name of pointNames) markPoints[name] = stats(rows.map((r) => r.markPoints[name]));
  const count = (pick) => rows.filter(pick).length;
  // The request list shown is the run whose page bytes sit at the median, so
  // the table and the number beside it describe the same visit.
  const median = metrics.bytes?.median;
  const representative = passes.find((p) => p.totals.bytes === median) ?? passes[0];
  return {
    runs: rows.length,
    ready: count((r) => r.ready),
    timedOut: count((r) => r.timedOut),
    heavyFeatureRequested: count((r) => r.heavyFeatureRequested),
    heavyUrls: [...new Set(passes.flatMap((p) => p.totals.heavyUrls))].sort(),
    heavyFeaturePrecached: count((r) => r.heavyFeaturePrecached),
    serviceWorkerHeavyUrls: [
      ...new Set(passes.flatMap((p) => p.totals.serviceWorker.heavyUrls)),
    ].sort(),
    heavyCodeLoaded: count((r) => r.heavyCodeLoaded),
    heavyCode: Object.fromEntries(
      Object.keys(HEAVY_CODE)
        .map((feature) => [
          feature,
          [...new Set(passes.flatMap((p) => p.heavyCode[feature] ?? []))].sort(),
        ])
        .filter(([, urls]) => urls.length > 0)
    ),
    webglAvailable: count((r) => r.webglAvailable),
    webglRenderer: passes.find((p) => p.webgl.renderer)?.webgl.renderer ?? null,
    serviceWorkerControlled: count((r) => r.serviceWorkerControlled),
    unpairedMarks: [...new Set(passes.flatMap((p) => p.marks.unpaired))].sort(),
    metrics,
    marks,
    markPoints,
    byKind: representative.totals.byKind,
    requests: representative.requests,
    errors: representative.errors.console,
    textSample: representative.textSample,
  };
}

function environment(host, distDir, browserPath, browserVersion) {
  const git = (cmd) => {
    const r = spawnSync('git', cmd, { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const distIndex = path.join(distDir, 'index.html');
  return {
    generatedAt: new Date().toISOString(),
    label: options.label,
    host,
    dist: path.relative(root, distDir).split(path.sep).join('/'),
    distBuiltAt: fs.existsSync(distIndex) ? fs.statSync(distIndex).mtime.toISOString() : null,
    package: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    git: {
      revision: git(['rev-parse', '--short', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      dirty: git(['status', '--porcelain']) !== '',
    },
    node: process.version,
    os: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model?.trim() ?? null,
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
    browser: browserVersion,
    browserPath,
    gpu: 'SwiftShader software WebGL (headless); not a GPU',
    viewport: '1280x800 @1x',
    transport: 'localhost HTTP/1.1, no compression, deployment cache headers',
    options: {
      runs: options.runs,
      settleMs: options.settleMs,
      timeoutMs: options.timeoutMs,
      bypassServiceWorker: options.bypassServiceWorker,
      scenarios: options.scenarios,
    },
  };
}

const kb = (n) => (n === null || n === undefined ? '—' : `${(n / 1024).toFixed(1)} KB`);
const ms = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)}`);
const fmt = (key, n) => {
  if (n === null || n === undefined) return '—';
  if (/bytes/i.test(key)) return kb(n);
  if (/Mb$/.test(key)) return n.toFixed(1);
  if (/Ms$/.test(key)) return ms(n);
  return String(Math.round(n * 10) / 10);
};

function renderMarkdown(summary) {
  const lines = [];
  lines.push(`# Bench: ${summary.label}`, '');
  const hosts = Object.entries(summary.hosts);
  for (const [hostName, host] of hosts) {
    const env = host.environment;
    lines.push(`## Host: ${hostName}`, '');
    lines.push(
      `Generated ${env.generatedAt} · ${env.dist} built ${env.distBuiltAt ?? 'unknown'} · package ${env.package} · git ${env.git.branch}@${env.git.revision}${env.git.dirty ? ' (dirty tree)' : ''}`,
      '',
      `${env.browser} headless · ${env.gpu} · ${env.cpu} (${env.cores} cores, ${env.memoryGb} GB) · ${env.os} · Node ${env.node}`,
      '',
      `${env.options.runs} runs per scenario, fresh profile each; cold = HTTP cache disabled, warm = second navigation in the same profile${env.options.bypassServiceWorker ? ' with the service worker bypassed' : ''}. ${env.transport}. Medians and nearest-rank p90 over runs.`,
      ''
    );
    for (const [name, sc] of Object.entries(host.scenarios)) {
      lines.push(`### ${name} — ${sc.title}`, '');
      lines.push(
        `${sc.description} Bundle: ${kb(sc.bundleBytes)} (${sc.bundleEntries.map((e) => `${e.path} ${kb(e.bytes)}`).join(', ')}).`,
        ''
      );
      const { cold, warm } = sc;
      const flags = (p) =>
        `ready ${p.ready}/${p.runs}${p.timedOut ? `, timed out ${p.timedOut}` : ''}; 3D module URL requested in ${p.heavyFeatureRequested}/${p.runs}; 3D code inside loaded JS in ${p.heavyCodeLoaded}/${p.runs}; WebGL2 available in ${p.webglAvailable}/${p.runs}${p.webglRenderer ? ` (${p.webglRenderer})` : ''}; service worker controlling ${p.serviceWorkerControlled}/${p.runs}`;
      lines.push(`- cold: ${flags(cold)}`, `- warm: ${flags(warm)}`, '');
      const heavyCode = Object.entries(cold.heavyCode);
      if (heavyCode.length) {
        lines.push(
          `Scripts carrying 3D code (cold): ${heavyCode.map(([feature, urls]) => `${feature} in ${urls.map((u) => `\`${u}\``).join(', ')}`).join('; ')}.`,
          ''
        );
      }
      lines.push(
        '| metric | cold median | cold p90 | warm median | warm p90 |',
        '|---|---:|---:|---:|---:|'
      );
      for (const [key, label] of NUMERIC) {
        const c = cold.metrics[key];
        const w = warm.metrics[key];
        if (!c && !w) continue;
        lines.push(
          `| ${label} | ${fmt(key, c?.median)} | ${fmt(key, c?.p90)} | ${fmt(key, w?.median)} | ${fmt(key, w?.p90)} |`
        );
      }
      lines.push('');
      const markNames = [
        ...new Set([...Object.keys(cold.marks), ...Object.keys(warm.marks)]),
      ].sort();
      if (markNames.length) {
        lines.push(
          '| phase (softn: marks, ms) | cold median | cold p90 | warm median | warm p90 |',
          '|---|---:|---:|---:|---:|'
        );
        for (const m of markNames) {
          lines.push(
            `| ${m} | ${ms(cold.marks[m]?.median)} | ${ms(cold.marks[m]?.p90)} | ${ms(warm.marks[m]?.median)} | ${ms(warm.marks[m]?.p90)} |`
          );
        }
        lines.push('');
      } else {
        lines.push('No `softn:` performance marks were recorded in this host.', '');
      }
      const pointNames = [
        ...new Set([...Object.keys(cold.markPoints), ...Object.keys(warm.markPoints)]),
      ].sort();
      if (pointNames.length) {
        lines.push('| mark (ms from navigation) | cold median | warm median |', '|---|---:|---:|');
        for (const m of pointNames)
          lines.push(
            `| ${m} | ${ms(cold.markPoints[m]?.median)} | ${ms(warm.markPoints[m]?.median)} |`
          );
        lines.push('');
      }
      const unpaired = [...new Set([...cold.unpairedMarks, ...warm.unpairedMarks])];
      if (unpaired.length) lines.push(`Unpaired marks: ${unpaired.join(', ')}.`, '');
      if (cold.heavyUrls.length)
        lines.push(
          `3D module URLs the page or a worker fetched (cold): ${cold.heavyUrls.map((u) => `\`${u}\``).join(', ')}.`,
          ''
        );
      if (cold.serviceWorkerHeavyUrls.length) {
        lines.push(
          `3D module URLs the service worker precached (cold, ${cold.heavyFeaturePrecached}/${cold.runs} runs): ${cold.serviceWorkerHeavyUrls.map((u) => `\`${u}\``).join(', ')}.`,
          ''
        );
      }
      if (cold.errors.length)
        lines.push(
          `Console errors (cold, representative run): ${cold.errors.map((e) => `\`${e}\``).join('; ')}.`,
          ''
        );
      for (const [passName, p] of [
        ['cold', cold],
        ['warm', warm],
      ]) {
        lines.push(
          `<details><summary>Requests, ${passName} pass (representative run: ${p.requests.length} rows)</summary>`,
          ''
        );
        lines.push(
          '| # | context | kind | status | bytes | cache | url |',
          '|---:|---|---|---:|---:|---|---|'
        );
        p.requests.forEach((r, i) => {
          const cache = r.fromServiceWorker
            ? 'sw'
            : r.fromMemoryCache
              ? 'memory'
              : r.fromDiskCache
                ? 'disk'
                : r.failed
                  ? `failed: ${r.error ?? ''}`
                  : 'network';
          lines.push(
            `| ${i + 1} | ${r.context} | ${r.kind} | ${r.status ?? '—'} | ${kb(r.bytes)} | ${cache} | \`${r.url}\` |`
          );
        });
        lines.push('', '</details>', '');
      }
    }
  }
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const hostDef = HOSTS[options.host];
  const distDir = path.resolve(root, options.dist || hostDef.dist);
  if (options.build) {
    const [cmd, cmdArgs] = hostDef.build;
    console.log(`Building ${options.host}: ${cmd} ${cmdArgs.join(' ')}`);
    const r = spawnSync(cmd, cmdArgs, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) throw new Error(`The ${options.host} build failed`);
  }
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(
      `${path.relative(root, distDir)} has no index.html. Build the host first (${hostDef.build[0]} ${hostDef.build[1].join(' ')}) or pass --build.`
    );
  }
  if (options.host === 'web') {
    // A web build made for /web/ has absolute asset URLs under that prefix;
    // served from the root here they 404 and the run measures a blank shell.
    const index = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    const base = /(?:src|href)="(\/[^"]*?)assets\//.exec(index)?.[1];
    if (base && base !== '/')
      throw new Error(
        `${hostDef.dist} was built with base ${base}; this harness serves it at /. Rebuild with VITE_BASE unset (npm run build -w @softn/web).`
      );
  }
  const browser = findBrowser();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-bench-bundles-'));
  const bundles = new Map();
  for (const name of options.scenarios) {
    const built = buildBundle(name);
    fs.writeFileSync(path.join(tmp, `${name}.softn`), built.bytes);
    bundles.set(name, built);
  }
  const server = await startServer({ host: options.host, distDir, bundles });
  console.log(`Serving ${path.relative(root, distDir)} at ${server.origin}; bundles in ${tmp}`);

  fs.mkdirSync(outDir, { recursive: true });
  if (options.writeRuns) fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true });
  const scenarioResults = {};
  let browserVersion = null;
  let failures = 0;
  try {
    for (const name of options.scenarios) {
      const scenario = SCENARIOS[name];
      const url = hostDef.url(server.origin, name);
      console.log(`\n${name}: ${url}`);
      const colds = [];
      const warms = [];
      for (let i = 1; i <= options.runs; i++) {
        const log = (line) => console.log(`  run ${i}/${options.runs} ${line}`);
        try {
          const result = await runOnce({ browser, url, scenario, origin: server.origin, log });
          browserVersion = result.browser;
          colds.push(result.cold);
          warms.push(result.warm);
          if (options.writeRuns) {
            fs.writeFileSync(
              path.join(outDir, 'runs', `${options.host}-${name}-${i}.json`),
              JSON.stringify(
                {
                  host: options.host,
                  scenario: name,
                  run: i,
                  url,
                  cold: result.cold,
                  warm: result.warm,
                },
                null,
                2
              )
            );
          }
        } catch (err) {
          failures++;
          log(`FAILED: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (colds.length === 0) continue;
      const built = bundles.get(name);
      scenarioResults[name] = {
        title: scenario.title,
        description: scenario.description,
        expectsHeavy: scenario.expectsHeavy,
        url: url.replace(server.origin, ''),
        bundleBytes: built.bytes.length,
        bundleEntries: built.entries,
        cold: aggregate(colds),
        warm: aggregate(warms),
        runs: colds.map((c, i) => ({ cold: scalars(c), warm: scalars(warms[i]) })),
      };
    }
  } finally {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // One summary per label, hosts side by side: a second invocation with the
  // other host adds to it rather than replacing it.
  const summaryPath = path.join(outDir, 'summary.json');
  let summary = { version: 1, label: options.label, hosts: {} };
  if (fs.existsSync(summaryPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      if (previous && previous.version === 1 && previous.hosts) summary = previous;
    } catch {
      // Unreadable: start over.
    }
  }
  summary.label = options.label;
  summary.hosts[options.host] = {
    environment: environment(options.host, distDir, browser, browserVersion),
    scenarios: scenarioResults,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.md'), renderMarkdown(summary));
  console.log(`\nWrote ${path.relative(root, summaryPath)} and summary.md`);
  if (failures) {
    console.error(`${failures} run(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
