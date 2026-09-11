/**
 * What the admission, proxy, policy and recovery suites share: a disposable
 * site root with the API copied in, PHP's built-in server started on it with
 * the ini values the deployed .user.ini asks for, a temp directory of its
 * own so leftover files are observable, and a way to run one PHP script
 * against the same library from the command line — where php://input is
 * stdin, which is the only place a body longer than its Content-Length can
 * be fed to the reader.
 *
 * Nothing here touches a real data directory: every server gets a root
 * under os.tmpdir() that stop() removes.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const apiDir = path.resolve(here, '../..');
export const repo = path.resolve(apiDir, '../..');
const require = createRequire(import.meta.url);

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
export const HAVE_PHP = php.status === 0;
export const skip = { skip: !HAVE_PHP };

export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules' || entry.name === 'data') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/** A small valid bundle built in memory; `extra` adds files (a padding blob, say). */
export function makeBundle(name, { permissions, version = '1.0.0', extra = {}, description } = {}) {
  const { zipSync, strToU8 } = require('fflate');
  const files = {
    'manifest.json': strToU8(
      JSON.stringify({
        name,
        version,
        description: description ?? `${name}, made by the test`,
        main: 'ui/main.ui',
        files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] },
      })
    ),
    'ui/main.ui': strToU8('<App><Text>hello</Text></App>\n'),
    'logic/main.logic': strToU8('let x = 1\n'),
  };
  if (permissions) files['permission.json'] = strToU8(JSON.stringify({ permissions }));
  for (const [k, v] of Object.entries(extra)) files[k] = v;
  return zipSync(files);
}

/** A 1×1 PNG, the smallest real image. */
export const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table.push(c >>> 0);
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crc32.table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A PNG whose header declares the given dimensions and whose data is a
 * single deflate block of nothing — enough for getimagesize, which reads
 * the IHDR chunk and no further, to report the size.
 */
export function pngDeclaring(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let nextPort = 5900 + Math.floor(Math.random() * 2000);

export async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 503) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

/**
 * The ini flags the deployed .user.ini asks for, with a temp directory of
 * the test's own.
 *
 * `display_errors` is off, so a warning never lands in a response. PHP
 * refuses a POST body past post_max_size before the script runs and, with
 * display_errors on, prints its warning into the response at that moment —
 * so the headers are already sent when index.php answers 413, its header()
 * call throws, and the client sees a 200 with a warning in the body. A
 * php.ini on the machine decided that before: Windows builds ship one that
 * keeps warnings off the output, the CI runner's does not, and only the
 * runner saw the 200. Off, not "stderr": the built-in server does not
 * honour the stderr value for that early warning. log_errors still sends
 * every warning to stderr, which the harness captures.
 */
export function iniArgs(tmp, ini = {}) {
  const settings = {
    sys_temp_dir: tmp,
    upload_tmp_dir: tmp,
    post_max_size: '64M',
    upload_max_filesize: '64M',
    memory_limit: '256M',
    display_errors: '0',
    log_errors: '1',
    ...ini,
  };
  const args = [];
  for (const [k, v] of Object.entries(settings)) args.push('-d', `${k}=${v}`);
  return args;
}

/** A site root with the API copied in and a data/config.json. */
export function makeRoot({ config = {}, demos = false, prefix = 'softn-api-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  copyDir(apiDir, path.join(root, 'api'));
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/config.json'), JSON.stringify({ seedDemos: demos, ...config }));
  if (demos) copyDir(path.join(repo, 'apps/softn-web/public/demos'), path.join(root, 'demos'));
  fs.mkdirSync(path.join(root, 'play'), { recursive: true });
  fs.writeFileSync(path.join(root, 'play/index.html'), '<!doctype html><html><head><title>Application</title></head><body><div id="root"></div></body></html>');
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><head><title>SoftN</title><meta name="description" content="site" /><meta property="og:title" content="SoftN" /><meta property="og:description" content="site" /><meta property="og:type" content="website" /><meta property="og:url" content="https://softn.com/" /><meta property="og:image" content="https://softn.com/og.png" /></head><body><div id="root"></div></body></html>'
  );
  return { root, tmp };
}

/**
 * Start a server on a fresh root. `config` is merged into data/config.json
 * (seeding is off unless asked: these suites publish what they test with).
 * `ini` overrides the -d values; the defaults mirror api/.user.ini so a body
 * near the bundle limit is PHP's to refuse only through the API's own check.
 */
export async function startServer({ config = {}, ini = {}, env = {}, demos = false, prefix = 'softn-api-' } = {}) {
  const { root, tmp } = makeRoot({ config, demos, prefix });
  const port = nextPort++;
  const base = `http://127.0.0.1:${port}`;
  const args = ['-S', `127.0.0.1:${port}`, ...iniArgs(tmp, ini), '-t', root, path.join(root, 'api/router.php')];
  const server = spawn('php', args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
  const log = [];
  server.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) if (/PHP (Warning|Fatal|Parse|Notice)|softn-api:/.test(line)) log.push(line);
  });
  await waitFor(`${base}/api/health`);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8'));

  async function api(method, route, { body, headers = {}, raw, query } = {}) {
    const init = { method, headers: { ...headers } };
    if (raw !== undefined) init.body = raw;
    else if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (query) route += (route.includes('?') ? '&' : '?') + query;
    const res = await fetch(base + route, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Publish a bundle as the admin, outside the hourly visitor limit. */
  async function publish(name, opts = {}, fields = {}) {
    const fd = new FormData();
    fd.append('bundle', new Blob([makeBundle(name, opts)]), 'app.softn');
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const r = await api('POST', '/api/apps', { body: fd, headers: { 'X-Admin-Key': cfg.adminKey } });
    if (r.status !== 201) throw new Error(`publish ${name}: ${r.status} ${r.text}`);
    return r.json;
  }

  /** The files left in the server's temp directory. */
  const tempFiles = () => fs.readdirSync(tmp);

  /** Wait until the temp directory is empty, or give up after a second: PHP's shutdown runs after the response is on the wire. */
  async function tempEmpty() {
    for (let i = 0; i < 20; i++) {
      if (tempFiles().length === 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  function stop() {
    server.kill();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* a handle PHP still held; the directory is under os.tmpdir() */
    }
  }

  return { root, base, port, api, publish, stop, adminKey: cfg.adminKey, dataDir: path.join(root, 'data'), tmp, tempFiles, tempEmpty, log };
}

function workerFile(dataDir, script, server) {
  const file = path.join(dataDir, `worker-${Math.random().toString(36).slice(2)}.php`);
  const libs = apiDir.replace(/\\/g, '/');
  fs.writeFileSync(
    file,
    `<?php
putenv('SOFTN_DATA_DIR=' . $argv[1]);
foreach (['http', 'db', 'catalog', 'bundle', 'apps', 'storage', 'social'] as $lib) require ${JSON.stringify(libs)} . '/lib/' . $lib . '.php';
foreach (json_decode(${JSON.stringify(JSON.stringify(server))}, true) as $k => $v) $_SERVER[$k] = $v;
${script}
`
  );
  return file;
}

/**
 * Run a PHP script that has the API's library loaded against a data
 * directory. `stdin` is what php://input reads on the CLI. The script text
 * runs after the requires; `$argv[1]` is the data directory, then `args`.
 * `server` seeds $_SERVER (REQUEST_METHOD, CONTENT_LENGTH, HTTP_* …).
 */
export function runPhp({ dataDir, script, stdin, env = {}, args = [], server = {} }) {
  const file = workerFile(dataDir, script, server);
  try {
    const r = spawnSync('php', ['-d', 'error_log=', file, dataDir, ...args], {
      encoding: 'utf8',
      input: stdin,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.unlinkSync(file);
  }
}

/** The same, started and left running: for a process that holds the lock until it is killed. */
export function startPhp({ dataDir, script, args = [], server = {} }) {
  const file = workerFile(dataDir, script, server);
  const p = spawn('php', ['-d', 'error_log=', file, dataDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) =>
    p.on('exit', (code) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
      resolve({ code, out, err });
    })
  );
  return { process: p, done };
}
