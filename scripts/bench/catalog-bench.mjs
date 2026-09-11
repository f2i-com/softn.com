#!/usr/bin/env node
/**
 * A load benchmark for the directory API's folder catalogue (API-03).
 *
 * The catalogue is a directory of app folders behind one exclusive lock:
 * every request takes the lock, reads every app.json, and a write commits
 * a JSON file through a temp sibling and a rename. That is a deliberate
 * design for shared hosting, and this script measures what it costs at
 * size rather than guessing: it builds disposable catalogues of N
 * synthetic apps under the system temp directory, starts several `php -S`
 * workers over each one (separate processes, so the lock is contended for
 * real), runs concurrent list / read / publish / update load, and reports
 * p50/p95 latency, lock wait and hold, cache rebuild time and disk usage,
 * as a table and as JSON. The per-request lock, boot, rebuild and commit
 * numbers come from the API's own Server-Timing header, which
 * `debugTimings` in the configuration turns on.
 *
 *   node scripts/bench/catalog-bench.mjs --sizes 100,1000 --workers 4 --concurrency 8 --requests 200
 *
 * Options: --sizes (default 100,1000,10000), --workers (php -S processes,
 * default 4), --concurrency (requests in flight, default 8), --requests
 * (per read phase; write phases run a quarter, default 200), --out
 * (JSON file; default under the system temp directory), --time-budget
 * (seconds per size, default 600: a size whose build and phases would run
 * past it is stopped and reported as such), --keep (leave the catalogue
 * on disk), --port (first port, default 5700).
 *
 * Nothing here touches a real data directory or the live site. Needs php
 * on PATH with zip; uses fflate from the repository's node_modules.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const apiDir = path.join(repo, 'apps/softn-api');
const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = require('fflate');

const args = parseArgs(process.argv.slice(2));
const SIZES = (args.sizes || '100,1000,10000').split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0);
const WORKERS = parseInt(args.workers || '4', 10);
const CONCURRENCY = parseInt(args.concurrency || '8', 10);
const REQUESTS = parseInt(args.requests || '200', 10);
const BUDGET_S = parseInt(args['time-budget'] || '600', 10);
const FIRST_PORT = parseInt(args.port || '5700', 10);
const KEEP = Boolean(args.keep);
const OUT = args.out || path.join(os.tmpdir(), `softn-catalog-bench-${Date.now()}.json`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

const phpVersion = (() => {
  const r = spawnSync('php', ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('php is not on PATH; nothing to measure.');
    process.exit(1);
  }
  return r.stdout.trim();
})();

const machine = {
  platform: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
  cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
  cores: os.cpus().length,
  memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
  node: process.version,
  php: phpVersion,
  workers: WORKERS,
  concurrency: CONCURRENCY,
};

// ── Fixtures ───────────────────────────────────────────────────────────────

const WORDS = 'orbit lantern harbour meadow copper signal quiet ledger tundra saffron pixel canyon willow ember glacier'.split(' ');
const TAGS = ['arcade', 'puzzle', 'tools', 'notes', '3d', 'simulation', 'music', 'drawing'];
const CATEGORIES = ['games', 'tools', 'creative', 'productivity', 'education', 'experiments', 'simulations', 'other'];

/** A minimal valid bundle; one in ten carries a 40 KB asset so sizes are not all identical. */
function bundle(i) {
  const name = `Bench App ${i}`;
  const files = {
    'manifest.json': strToU8(
      JSON.stringify({
        name,
        version: '1.0.0',
        description: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${WORDS[(i * 13) % WORDS.length]}, a synthetic app for the benchmark`,
        main: 'ui/main.ui',
        files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] },
        author: `Author ${i % 50}`,
      })
    ),
    'ui/main.ui': strToU8(`<App><Text>${name}</Text></App>\n`),
    'logic/main.logic': strToU8('let x = 1\n'),
  };
  if (i % 10 === 0) files['assets/pad.bin'] = new Uint8Array(40 * 1024).map((_, k) => (k * 31 + i) & 0xff);
  return zipSync(files);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules' || entry.name === 'data') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

const ADMIN_KEY = 'bench-admin-key-' + '0'.repeat(24);

/** A site root with N app folders. app.json is left for discovery, so the first request is the cold rebuild. */
function buildCatalogue(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `softn-bench-${n}-`));
  copyDir(apiDir, path.join(root, 'api'));
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.mkdirSync(path.join(root, 'play'));
  fs.writeFileSync(path.join(root, 'play/index.html'), '<!doctype html><html><head><title>Application</title></head><body></body></html>');
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><title>SoftN</title></head><body></body></html>');
  fs.mkdirSync(path.join(root, 'data/apps'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data/config.json'),
    JSON.stringify({
      seedDemos: false,
      debugTimings: true,
      salt: 'bench-salt',
      adminKey: ADMIN_KEY,
      limits: { publish: [1000000, 3600], version: [1000000, 3600], run: [1000000, 60], comment: [1000000, 600], rate: [1000000, 600] },
    })
  );
  for (let i = 0; i < n; i++) {
    const dir = path.join(root, 'data/apps', `bench-app-${i}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'v1.softn'), bundle(i));
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ schemaVersion: 1, app: { name: `Bench App ${i}`, category: CATEGORIES[i % CATEGORIES.length], tags: [TAGS[i % TAGS.length], TAGS[(i * 3) % TAGS.length]] } })
    );
  }
  return root;
}

// ── Servers ────────────────────────────────────────────────────────────────

async function waitFor(url, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

function startWorkers(root, count, firstPort) {
  const tmp = path.join(root, 'tmp');
  const workers = [];
  for (let i = 0; i < count; i++) {
    const port = firstPort + i;
    const p = spawn(
      'php',
      ['-S', `127.0.0.1:${port}`, '-d', `sys_temp_dir=${tmp}`, '-d', `upload_tmp_dir=${tmp}`, '-d', 'post_max_size=64M', '-d', 'upload_max_filesize=64M', '-d', 'memory_limit=256M', '-t', root, path.join(root, 'api/router.php')],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    const log = [];
    p.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) if (/PHP (Warning|Fatal|Parse)|softn-api:/.test(line)) log.push(line);
    });
    workers.push({ port, base: `http://127.0.0.1:${port}`, process: p, log });
  }
  return workers;
}

// ── Load ───────────────────────────────────────────────────────────────────

function parseServerTiming(header) {
  const out = { lock: null, hold: null, boot: null, rebuild: null, rebuildCount: null, commit: null, commitCount: null };
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = part.trim().match(/^(\w+);dur=([\d.]+)(?:;desc="(\d+)[^"]*")?/);
    if (!m) continue;
    const [, name, dur, count] = m;
    if (name in out) out[name] = parseFloat(dur);
    if (name === 'rebuild') out.rebuildCount = count === undefined ? null : parseInt(count, 10);
    if (name === 'commit') out.commitCount = count === undefined ? null : parseInt(count, 10);
  }
  return out;
}

/** One request, timed from before fetch to after the body is consumed. */
async function timed(base, method, route, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const t0 = performance.now();
  let status = 0;
  let timing = parseServerTiming(null);
  try {
    const res = await fetch(base + route, init);
    await res.arrayBuffer();
    status = res.status;
    timing = parseServerTiming(res.headers.get('server-timing'));
  } catch {
    status = -1;
  }
  return { ms: performance.now() - t0, status, ...timing };
}

/** `total` requests, `concurrency` at a time, round-robin over the workers. */
async function runPhase(name, workers, total, concurrency, makeRequest) {
  const samples = [];
  let next = 0;
  const started = performance.now();
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const w = workers[i % workers.length];
      samples.push(await makeRequest(w.base, i));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, lane));
  const wall = performance.now() - started;
  return summarise(name, samples, wall);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

function summarise(name, samples, wallMs) {
  const of = (key) => samples.map((s) => s[key]).filter((v) => typeof v === 'number');
  const lat = of('ms');
  return {
    phase: name,
    requests: samples.length,
    errors: samples.filter((s) => s.status < 200 || s.status >= 300).length,
    rps: r1(samples.length / (wallMs / 1000)),
    latencyMs: { p50: r1(percentile(lat, 50)), p95: r1(percentile(lat, 95)), max: r1(Math.max(...lat)) },
    lockWaitMs: { p50: r1(percentile(of('lock'), 50)), p95: r1(percentile(of('lock'), 95)), max: r1(Math.max(...of('lock'), 0)) },
    lockHoldMs: { p50: r1(percentile(of('hold'), 50)), p95: r1(percentile(of('hold'), 95)), max: r1(Math.max(...of('hold'), 0)) },
    bootMs: { p50: r1(percentile(of('boot'), 50)), p95: r1(percentile(of('boot'), 95)) },
    rebuild: { bundles: of('rebuildCount').reduce((a, b) => a + b, 0), ms: r1(of('rebuild').reduce((a, b) => a + b, 0)) },
    commit: { files: of('commitCount').reduce((a, b) => a + b, 0), msP50: r1(percentile(of('commit').filter((v) => v > 0), 50)) },
  };
}

function diskUsage(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        bytes += fs.statSync(p).size;
        files++;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

// ── One size ───────────────────────────────────────────────────────────────

async function benchSize(n, index) {
  const started = performance.now();
  const elapsedS = () => (performance.now() - started) / 1000;
  process.stdout.write(`\n== ${n} apps ==\n`);
  process.stdout.write(`building catalogue… `);
  const root = buildCatalogue(n);
  process.stdout.write(`${r1(elapsedS())} s\n`);
  const result = { apps: n, phases: [], notes: [] };
  const workers = startWorkers(root, WORKERS, FIRST_PORT + index * WORKERS);
  try {
    // The first worker's first request is the cold catalogue: every bundle
    // inspected, every app.json completed and committed. Health is used for
    // the wait so the cold list is the first catalogue request measured.
    await waitFor(`${workers[0].base}/api/README.md`);
    const cold = await timed(workers[0].base, 'GET', '/api/apps?perPage=24');
    result.cold = { latencyMs: r1(cold.ms), bootMs: r1(cold.boot), rebuildBundles: cold.rebuildCount, rebuildMs: r1(cold.rebuild), commitFiles: cold.commitCount, commitMs: r1(cold.commit), status: cold.status };
    process.stdout.write(`cold first request: ${r1(cold.ms)} ms (rebuild ${cold.rebuildCount} bundles in ${r1(cold.rebuild)} ms, ${cold.commitCount} commits in ${r1(cold.commit)} ms)\n`);
    for (const w of workers.slice(1)) await waitFor(`${w.base}/api/README.md`);
    // Each worker's first boot reads the cache the cold request wrote.
    for (const w of workers) await timed(w.base, 'GET', '/api/apps?perPage=24');
    const warm = await timed(workers[0].base, 'GET', '/api/apps?perPage=24');
    result.warm = { latencyMs: r1(warm.ms), bootMs: r1(warm.boot) };
    process.stdout.write(`warm list: ${r1(warm.ms)} ms (boot ${r1(warm.boot)} ms)\n`);
    if (elapsedS() > BUDGET_S) {
      result.notes.push(`stopped after the cold request: ${r1(elapsedS())} s exceeds the ${BUDGET_S} s budget`);
      return result;
    }
    const pages = Math.max(1, Math.ceil(n / 24));
    const phases = [
      ['list', REQUESTS, (base, i) => timed(base, 'GET', i % 4 === 0 ? `/api/apps?q=${WORDS[i % WORDS.length]}&perPage=24` : `/api/apps?page=${1 + (i * 7) % pages}&perPage=24&sort=${['trending', 'newest', 'name'][i % 3]}`)],
      ['read', REQUESTS, (base, i) => timed(base, 'GET', `/api/apps/bench-app-${(i * 13) % n}`)],
      ['publish', Math.max(4, Math.floor(REQUESTS / 4)), (base, i) => timed(base, 'POST', '/api/apps', { raw: bundle(n + i), headers: { 'Content-Type': 'application/octet-stream', 'X-Admin-Key': ADMIN_KEY } })],
      ['update', Math.max(4, Math.floor(REQUESTS / 4)), (base, i) => timed(base, 'PATCH', `/api/apps/bench-app-${(i * 17) % n}`, { body: { description: `updated ${i}` }, headers: { 'X-Admin-Key': ADMIN_KEY } })],
      [
        'mixed',
        REQUESTS,
        (base, i) => {
          const k = i % 10;
          if (k < 5) return timed(base, 'GET', `/api/apps?page=${1 + (i * 7) % pages}&perPage=24`);
          if (k < 8) return timed(base, 'GET', `/api/apps/bench-app-${(i * 13) % n}`);
          if (k === 8) return timed(base, 'POST', `/api/apps/bench-app-${(i * 13) % n}/runs`);
          return timed(base, 'PATCH', `/api/apps/bench-app-${(i * 17) % n}`, { body: { description: `mixed ${i}` }, headers: { 'X-Admin-Key': ADMIN_KEY } });
        },
      ],
    ];
    for (const [name, total, make] of phases) {
      if (elapsedS() > BUDGET_S) {
        result.notes.push(`phase ${name} skipped: ${r1(elapsedS())} s exceeds the ${BUDGET_S} s budget`);
        continue;
      }
      process.stdout.write(`${name} (${total} requests, ${CONCURRENCY} in flight over ${WORKERS} workers)… `);
      const summary = await runPhase(name, workers, total, CONCURRENCY, make);
      result.phases.push(summary);
      process.stdout.write(`p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms, lock wait p95 ${summary.lockWaitMs.p95} ms, ${summary.errors} errors\n`);
    }
    const data = diskUsage(path.join(root, 'data'));
    const cache = fs.existsSync(path.join(root, 'data/cache/bundles.json')) ? fs.statSync(path.join(root, 'data/cache/bundles.json')).size : 0;
    result.disk = { dataBytes: data.bytes, files: data.files, cacheBytes: cache, bytesPerApp: Math.round(data.bytes / n) };
    result.elapsedS = r1(elapsedS());
    const complaints = workers.flatMap((w) => w.log);
    if (complaints.length) result.notes.push(`PHP complained ${complaints.length} times; first: ${complaints[0]}`);
    return result;
  } finally {
    for (const w of workers) w.process.kill();
    if (!KEEP) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        result.notes.push(`could not remove ${root}`);
      }
    } else result.notes.push(`kept at ${root}`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

function table(results) {
  const rows = [];
  const head = ['apps', 'phase', 'req', 'err', 'rps', 'lat p50', 'lat p95', 'lat max', 'lock p50', 'lock p95', 'hold p50', 'hold p95', 'boot p50', 'rebuild', 'commit p50'];
  rows.push(head);
  for (const r of results) {
    rows.push([r.apps, 'cold', 1, r.cold.status >= 300 ? 1 : 0, '', r.cold.latencyMs, '', '', '', '', '', '', r.cold.bootMs, `${r.cold.rebuildBundles} in ${r.cold.rebuildMs}`, r.cold.commitMs]);
    for (const p of r.phases) {
      rows.push([r.apps, p.phase, p.requests, p.errors, p.rps, p.latencyMs.p50, p.latencyMs.p95, p.latencyMs.max, p.lockWaitMs.p50, p.lockWaitMs.p95, p.lockHoldMs.p50, p.lockHoldMs.p95, p.bootMs.p50, `${p.rebuild.bundles} in ${p.rebuild.ms}`, p.commit.msP50 ?? '']);
    }
  }
  const widths = head.map((_, c) => Math.max(...rows.map((row) => String(row[c] ?? '').length)));
  return rows.map((row, i) => row.map((v, c) => String(v ?? '').padStart(widths[c])).join('  ') + (i === 0 ? '\n' + widths.map((w) => '-'.repeat(w)).join('  ') : '')).join('\n');
}

const results = [];
for (let i = 0; i < SIZES.length; i++) results.push(await benchSize(SIZES[i], i));

console.log('\nAll times in milliseconds; lock/hold/boot/rebuild/commit are the server\'s own (Server-Timing).');
console.log(table(results));
for (const r of results) {
  if (r.disk) console.log(`${r.apps} apps: data/ is ${(r.disk.dataBytes / 1024 / 1024).toFixed(1)} MB in ${r.disk.files} files (${r.disk.bytesPerApp} bytes per app); cache/bundles.json ${(r.disk.cacheBytes / 1024).toFixed(0)} KB; ${r.elapsedS} s for the size`);
  for (const n of r.notes) console.log(`${r.apps} apps: ${n}`);
}
const report = { generatedAt: new Date().toISOString(), machine, settings: { requests: REQUESTS, sizes: SIZES, timeBudgetS: BUDGET_S }, results };
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nJSON written to ${OUT}`);
