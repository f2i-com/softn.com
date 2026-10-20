/**
 * The server rules the site build ships, run by the servers themselves.
 *
 * package-site.test.mjs reads `.htaccess` and `nginx.conf.example` as text,
 * and two faults got past it that only a server shows:
 * - Apache sent every .gz twin as application/gzip. AddEncoding names a twin's
 *   encoding, but the type came from the last extension with one, and the
 *   host's mime.types gives .gz one. A browser asks for gzip rather than
 *   brotli over plain HTTP, and it saved every page as a file and refused
 *   every script and stylesheet.
 * - nginx refused to start: `brotli_static` is the third-party ngx_brotli
 *   module's directive, and nginx rejects one it does not know.
 *
 * Each server here serves a small tree of the build's shape (every file with
 * its .br and .gz twins, written by the build's own compressTwins) through the
 * rules exactly as build-site.mjs writes them, and each file is asked for as a
 * browser on HTTPS asks (br), as one on plain HTTP asks (gzip), and by a
 * client that takes no encoding. Needs `apache2` or `nginx` (the GitHub Ubuntu
 * runners have both, installed and stopped); a machine without one skips it.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compressTwins } from '../lib/compress-twins.mjs';

// build-site.mjs runs the build when imported, so the rules are read from its source.
const buildSource = fs.readFileSync(new URL('../build/build-site.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function rawBlock(name) {
  const match = buildSource.match(new RegExp(`const ${name} = String\\.raw\`([\\s\\S]*?)\\n\`;`));
  assert.ok(match, `${name} in build-site.mjs`);
  return match[1];
}

/** The first of the names that runs, or null. */
function found(...candidates) {
  if (process.platform !== 'linux') return null;
  return candidates.find((bin) => spawnSync(bin, ['-v'], { stdio: 'ignore' }).status === 0) ?? null;
}
const APACHE_MODULES = '/usr/lib/apache2/modules';
const apache = fs.existsSync(APACHE_MODULES) ? found('apache2', '/usr/sbin/apache2') : null;
const nginx = fs.existsSync('/etc/nginx/mime.types') ? found('nginx', '/usr/sbin/nginx') : null;

const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const FILES = [
  ['index.html', Buffer.from(`<!doctype html><title>SoftN</title>\n${'<p>The site.</p>\n'.repeat(200)}`), /^text\/html\b/],
  ['assets/index-1a2b3c4d.js', Buffer.from('export const answer = 42;\n'.repeat(200)), /^(?:text|application)\/javascript\b/],
  ['assets/index-1a2b3c4d.css', Buffer.from('main { display: grid; }\n'.repeat(200)), /^text\/css\b/],
  ['shared/assets/zipp_wasm_bg-1a2b3c4d.wasm', Buffer.concat([WASM_HEADER, Buffer.alloc(8192, 7)]), /^application\/wasm\b/],
];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-server-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'site');
  const files = FILES.map(([name, source, type]) => {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
    const { brotli, gzip } = compressTwins(source);
    fs.writeFileSync(`${full}.br`, brotli);
    fs.writeFileSync(`${full}.gz`, gzip);
    return { url: `/${name}`, source, type, br: brotli, gzip };
  });
  return { dir, root, files };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function get(port, url, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

/**
 * Runs `check` against the server started in the foreground, once it answers,
 * and stops the server before the fixture is removed.
 */
async function withServer(command, args, port, log, check) {
  // A process group of its own: Apache's prefork stops by signalling its
  // whole group, which in the foreground would otherwise be this test runner's.
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    let up = false;
    for (let tries = 0; tries < 100 && !up && child.exitCode === null; tries += 1) {
      up = await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.end();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
      });
      if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!up) assert.fail(`${command} did not start: ${stderr}${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''}`);
    await check();
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
}

/**
 * Every file, as each client asks for it: the twin of the encoding it takes
 * (`brotli` says whether the server serves .br at all), under the original's
 * type, with Vary on what was compressed.
 */
async function checkTwins(port, files, { brotli }) {
  const clients = [
    ['br, gzip, deflate', brotli ? 'br' : 'gzip'],
    ['gzip, deflate', 'gzip'],
    [null, undefined],
  ];
  for (const file of files) {
    for (const [accept, encoding] of clients) {
      const label = `${file.url} for Accept-Encoding: ${accept ?? '(none)'}`;
      const res = await get(port, file.url, accept ? { 'Accept-Encoding': accept } : {});
      assert.equal(res.status, 200, label);
      assert.match(res.headers['content-type'] ?? '', file.type, `${label}: the original's type`);
      assert.equal(res.headers['content-encoding'], encoding, label);
      assert.ok(res.body.equals(encoding === 'br' ? file.br : encoding === 'gzip' ? file.gzip : file.source), `${label}: the ${encoding ?? 'original'} bytes`);
      if (encoding) assert.match(res.headers.vary ?? '', /\bAccept-Encoding\b/i, `${label}: Vary`);
    }
  }
}

test('Apache serves each twin under its original type, through the shipped .htaccess', { skip: apache ? false : 'apache2 is not installed' }, async (t) => {
  const { dir, root, files } = fixture(t);
  fs.writeFileSync(path.join(root, '.htaccess'), rawBlock('APACHE_CONFIG'));
  const port = await freePort();
  const modules = ['mpm_prefork', 'authz_core', 'mime', 'dir', 'rewrite', 'headers', 'filter', 'deflate'];
  const conf = path.join(dir, 'httpd.conf');
  fs.writeFileSync(conf, [
    `ServerRoot "${dir}"`,
    'ServerName localhost',
    `Listen 127.0.0.1:${port}`,
    `PidFile "${dir}/httpd.pid"`,
    `DefaultRuntimeDir "${dir}"`,
    `ErrorLog "${dir}/error.log"`,
    ...modules.map((name) => `LoadModule ${name}_module ${APACHE_MODULES}/mod_${name}.so`),
    // The host's own types, as a real one has: this is where .gz gets one.
    'TypesConfig /etc/mime.types',
    `DocumentRoot "${root}"`,
    '<Directory />\n  AllowOverride None\n  Require all denied\n</Directory>',
    `<Directory "${root}">\n  AllowOverride All\n  Require all granted\n</Directory>`,
    '',
  ].join('\n'));
  await withServer(apache, ['-f', conf, '-D', 'FOREGROUND'], port, path.join(dir, 'error.log'), async () => {
    await checkTwins(port, files, { brotli: true });
    // The front door is index.html's twin too, and a missing asset stays a 404.
    const front = await get(port, '/', { 'Accept-Encoding': 'gzip' });
    assert.equal(front.headers['content-encoding'], 'gzip');
    assert.match(front.headers['content-type'] ?? '', /^text\/html\b/);
    assert.equal((await get(port, '/assets/missing-1a2b3c4d.js', { 'Accept-Encoding': 'gzip' })).status, 404);
  });
});

test('nginx starts on the shipped config without ngx_brotli, and serves each .gz twin under its original type', { skip: nginx ? false : 'nginx is not installed' }, async (t) => {
  const { dir, root, files } = fixture(t);
  const port = await freePort();
  const server = rawBlock('NGINX_CONFIG')
    .replace(/^\s*listen \[::\]:80;\n/m, '')
    .replace('listen 80;', `listen 127.0.0.1:${port};`)
    .replace('root /var/www/softn;', `root ${root};`)
    .replaceAll('include fastcgi_params;', 'include /etc/nginx/fastcgi_params;');
  assert.ok(server.includes(`listen 127.0.0.1:${port};`) && server.includes(`root ${root};`), 'the example still has the listen and root it is installed by changing');
  const conf = path.join(dir, 'nginx.conf');
  const temp = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((kind) => `  ${kind}_temp_path ${dir}/${kind};`).join('\n');
  fs.writeFileSync(conf, `daemon off;\nworker_processes 1;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents {}\nhttp {\n  access_log off;\n${temp}\n${server}\n}\n`);
  const args = ['-p', `${dir}/`, '-c', conf];
  // `nginx -t` is the step DEPLOY.md gives; it is what failed.
  const tested = spawnSync(nginx, ['-t', ...args], { encoding: 'utf8' });
  assert.equal(tested.status, 0, `nginx -t: ${tested.stderr}`);
  await withServer(nginx, args, port, path.join(dir, 'error.log'), () => checkTwins(port, files, { brotli: false }));
});
