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
 * - nginx served data/ to anyone, the admin key included: `location /data/`
 *   read as a refusal, and a regular expression beats a plain prefix, so the
 *   rule for ordinary files answered every path in it with a dot.
 * - Apache served .git/config and .env, which "real files win" lets through
 *   and FilesMatch, seeing no folder of a path, does not stop.
 * - A file app with a dot in its name was lost on a reload, on both.
 *
 * Each server here serves a small tree of the build's shape (every file with
 * its .br and .gz twins, written by the build's own compressTwins) through the
 * rules exactly as build-site.mjs writes them, and each file is asked for as a
 * browser on HTTPS asks (br), as one on plain HTTP asks (gzip), and by a
 * client that takes no encoding. What must not be served is planted in it and
 * asked for. The packages' rules and the nginx blocks in their guides get the
 * same. Needs `apache2` or `nginx` (the GitHub Ubuntu runners have both,
 * installed and stopped); a machine without one skips it.
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
  ['web/index.html', Buffer.from(`<!doctype html><title>SoftN Web</title>\n${'<p>The runtime.</p>\n'.repeat(200)}`), /^text\/html\b/],
  ['assets/index-1a2b3c4d.js', Buffer.from('export const answer = 42;\n'.repeat(200)), /^(?:text|application)\/javascript\b/],
  ['assets/index-1a2b3c4d.css', Buffer.from('main { display: grid; }\n'.repeat(200)), /^text\/css\b/],
  ['shared/assets/zipp_wasm_bg-1a2b3c4d.wasm', Buffer.concat([WASM_HEADER, Buffer.alloc(8192, 7)]), /^application\/wasm\b/],
];

/** What every planted file says, which no answer may hold. */
const NOT_FOR_VISITORS = 'not for visitors';
/** What a folder uploaded to a host can hold, whichever package it is. */
const STRAY = ['.git/config', '.git/HEAD', '.env', '.env.local', '.DS_Store', 'config.json', 'backup.zip', 'BACKUP.ZIP', 'backup.tar', 'data.tar.gz', 'site.sql', 'Site.SQL', 'site.sql.gz', 'database.sqlite', 'database.sqlite-wal', 'index.html.bak'];
/** The site's state, and that same state where a backup of it was left. */
const SITE_PRIVATE = [...STRAY, 'data/config.json', 'data/categories.json', 'data/README.txt', 'data/apps/notes/app.json', 'data/apps/notes/v1.softn', 'data/apps/notes/comments.json', 'data/apps/notes/storage.sqlite', 'data-backup/config.json'];
/** data/config.json as other requests spell it, which reach the same file if a rule reads the text. */
const SPELLINGS = ['/data%2Fconfig.json', '//data/config.json', '/web/../data/config.json', '/web/%2e%2e/data/config.json', '/data/./config.json', '/data', '/data/'];
/** A certificate's challenge is a dot folder that is meant to be served. */
const CHALLENGE = '.well-known/acme-challenge/token';
/** Addresses in the runtime: a reload of each is the runtime's page, whatever it looks like. */
const APP_ADDRESSES = ['/web/app/~Plain%20App', '/web/app/~Notes%20v1.2', '/web/app/~Dr.%20Mario', '/web/app/~..', '/web/app/~...', '/web/app/~.hidden', '/web/app/~Report.softn', '/web/app/~engine.wasm', '/web/app/~x.js', '/web/app/~Backup.zip', '/web/app/~config.json', '/web/app/~My~2FApp', '/web/app/notes/page.v2'];

function plant(root, names, body = NOT_FOR_VISITORS) {
  for (const name of names) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

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
  plant(root, SITE_PRIVATE);
  plant(root, [CHALLENGE], 'the challenge');
  return { dir, root, files };
}

/** Each of these answers no file, to a fetch and to a browser's navigation, whatever the status. */
async function checkRefused(port, urls) {
  for (const url of urls) {
    for (const accept of ['*/*', 'text/html']) {
      const res = await get(port, url, { Accept: accept });
      assert.ok(res.status === 403 || res.status === 404, `${url} for Accept: ${accept} answered ${res.status}`);
      assert.ok(!res.body.includes(NOT_FOR_VISITORS), `${url} for Accept: ${accept} gave the file away`);
    }
  }
}

/** A browser reloading an app's address gets the runtime; anything else asking for it does not. */
async function checkAddresses(port) {
  for (const url of APP_ADDRESSES) {
    const page = await get(port, url, { Accept: 'text/html' });
    assert.equal(page.status, 200, `a reload of ${url}`);
    assert.ok(page.body.includes('The runtime.'), `a reload of ${url} is the runtime's page`);
    assert.equal((await get(port, url, { Accept: '*/*' })).status, 404, `${url} asked for as a file`);
  }
}

/** The private files, and the challenge that looks like them and is not. */
async function checkPrivate(port) {
  await checkRefused(port, [...SITE_PRIVATE.map((name) => `/${name}`), ...SPELLINGS]);
  assert.equal((await get(port, `/${CHALLENGE}`)).status, 200, 'a certificate challenge');
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

test('coi.js is asked for as sw.js is: sw.js loads it, and a stale copy outlives the new worker', () => {
  assert.match(buildSource, /<FilesMatch "\^\(\?:registerSW\|sw\|service-worker\|coi\)\\\.js/, 'Apache');
  assert.match(buildSource, /\(\?:registerSW\|sw\|service-worker\|coi\)\\\.js\$\s+"no-cache/, 'nginx');
});

/** Apache on `root`, reading its .htaccess files, for as long as `check` runs. */
async function withApache(dir, root, port, check) {
  const modules = ['mpm_prefork', 'authz_core', 'mime', 'dir', 'rewrite', 'headers', 'filter', 'deflate', 'alias'];
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
  await withServer(apache, ['-f', conf, '-D', 'FOREGROUND'], port, path.join(dir, 'error.log'), check);
}

/** nginx on the `server { }` block given, for as long as `check` runs. */
async function withNginx(dir, port, server, check) {
  const conf = path.join(dir, 'nginx.conf');
  const temp = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((kind) => `  ${kind}_temp_path ${dir}/${kind};`).join('\n');
  fs.writeFileSync(conf, `daemon off;\nworker_processes 1;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents {}\nhttp {\n  access_log off;\n${temp}\n${server}\n}\n`);
  const args = ['-p', `${dir}/`, '-c', conf];
  // `nginx -t` is the step DEPLOY.md gives; it is what failed.
  const tested = spawnSync(nginx, ['-t', ...args], { encoding: 'utf8' });
  assert.equal(tested.status, 0, `nginx -t: ${tested.stderr}`);
  await withServer(nginx, args, port, path.join(dir, 'error.log'), check);
}

test('Apache serves each twin under its original type, through the shipped .htaccess', { skip: apache ? false : 'apache2 is not installed' }, async (t) => {
  const { dir, root, files } = fixture(t);
  fs.writeFileSync(path.join(root, '.htaccess'), rawBlock('APACHE_CONFIG'));
  fs.copyFileSync(new URL('../../apps/softn-api/data/.htaccess', import.meta.url), path.join(root, 'data/.htaccess'));
  const port = await freePort();
  await withApache(dir, root, port, async () => {
    await checkTwins(port, files, { brotli: true });
    // The front door is index.html's twin too, and a missing asset stays a 404.
    const front = await get(port, '/', { 'Accept-Encoding': 'gzip' });
    assert.equal(front.headers['content-encoding'], 'gzip');
    assert.match(front.headers['content-type'] ?? '', /^text\/html\b/);
    assert.equal((await get(port, '/assets/missing-1a2b3c4d.js', { 'Accept-Encoding': 'gzip' })).status, 404);
    await checkPrivate(port);
    await checkAddresses(port);
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
  await withNginx(dir, port, server, async () => {
    await checkTwins(port, files, { brotli: false });
    await checkPrivate(port);
    await checkAddresses(port);
    // The API's addresses are routes. PHP-FPM is not here: a 502 is one that reached the location for it.
    for (const route of ['/api/apps', '/api/x/config.json', '/api/x/export.zip', '/api/.user.ini']) assert.equal((await get(port, route)).status, 502, route);
  });
});

/** A package's public folder: its own rules, what it serves, and strays beside them. */
function packageFixture(t, served) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-server-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'webroot');
  plant(root, served, 'served');
  return { dir, root };
}

for (const [file, served] of [
  ['apps/softn-single/public/.htaccess', ['index.html', 'runtime.config.json', 'app.softn']],
  ['apps/softn-host-php/htaccess', ['index.html', 'runtime.config.json', 'app.softn']],
  ['apps/softn-single-private/public/.htaccess', ['assets/index-1a2b3c4d.js']],
  ['apps/softn-single-private/htaccess-backend', ['assets/index-1a2b3c4d.js']],
]) {
  test(`${file} refuses dot folders and backups`, { skip: apache ? false : 'apache2 is not installed' }, async (t) => {
    const { dir, root } = packageFixture(t, [...served, CHALLENGE]);
    plant(root, STRAY);
    fs.copyFileSync(new URL(`../../${file}`, import.meta.url), path.join(root, '.htaccess'));
    // No PHP here: the rewrite is what is being looked at, and it lands on this file.
    const routes = /host-php|htaccess-backend/.test(file);
    if (routes) plant(root, ['api.php'], 'the app\'s own route');
    const port = await freePort();
    await withApache(dir, root, port, async () => {
      await checkRefused(port, STRAY.map((name) => `/${name}`));
      for (const name of [...served, CHALLENGE]) assert.equal((await get(port, `/${name}`)).status, 200, name);
      // These rules run ahead of the rewrite, and a route may end in anything.
      for (const route of routes ? ['/api/meta', '/api/export.zip', '/api/config.json', '/api/.env'] : []) {
        const answer = await get(port, route);
        assert.equal(answer.status, 200, route);
        assert.equal(answer.body.toString(), 'the app\'s own route', route);
      }
      // That spares routes and no more: a copy of the site in a folder of its own has an api folder too.
      if (routes) {
        const copies = ['old/api/.env', 'old/api/.git/config', 'old/api/backup.zip', 'old/api/site.sql', 'old/api/config.json'];
        plant(root, copies);
        await checkRefused(port, copies.map((name) => `/${name}`));
      }
    });
  });
}

/** The ```nginx block in a hosting guide, in a server of its own on `root`. */
function guideServer(file, port, root) {
  const guide = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = guide.match(/```nginx\n([\s\S]*?)```/)?.[1];
  assert.ok(block, `the nginx block in ${file}`);
  assert.match(block, /^root \/srv\/site\/webroot;/m, 'the block is the one that names the document root');
  const body = block
    .replace(/^root \/srv\/site\/webroot;/m, `root ${root};`)
    .replaceAll('include fastcgi_params;', 'include /etc/nginx/fastcgi_params;')
    .replaceAll('include mime.types;', 'include /etc/nginx/mime.types;');
  return `server {\n  listen 127.0.0.1:${port};\n${body}\n}`;
}

/** In a public folder, by the mistake each guide warns of: everything unpacked into it, and more. */
const BACKEND_AND_PRIVATE = ['backend/private/config.json', 'backend/private/data/application.sqlite', 'backend/app/manifest.json', 'backend/runner.mjs', 'backend/setup.php', 'private/app.softn', 'private/serve.config.php', 'private/secret.key', 'private/digest.cache', 'serve.config.php', 'api.php', 'softn-serve.php'];

for (const [file, served, refused] of [
  ['apps/softn-host-php/README.md', ['index.html', 'runtime.config.json', 'app.softn', 'assets/index-1a2b3c4d.js'], []],
  ['docs/engineering/SINGLE_APP_PRIVATE.md', ['sw.js', 'assets/index-1a2b3c4d.js'], ['app.softn']],
]) {
  test(`the nginx block in ${file} refuses what the guide says it does`, { skip: nginx ? false : 'nginx is not installed' }, async (t) => {
    const { dir, root } = packageFixture(t, [...served, CHALLENGE, 'index.php']);
    plant(root, [...STRAY, ...BACKEND_AND_PRIVATE, ...refused]);
    const port = await freePort();
    await withNginx(dir, port, guideServer(file, port, root), async () => {
      await checkRefused(port, [...STRAY, ...BACKEND_AND_PRIVATE, ...refused].map((name) => `/${name}`));
      for (const name of [...served, CHALLENGE]) assert.equal((await get(port, `/${name}`)).status, 200, name);
      // PHP-FPM is not here: a 502 is an address that reached the location for it.
      const php = file.includes('host-php') ? ['/api/meta', '/api/export.zip', '/api/config.json'] : ['/', '/index.php'];
      for (const route of php) assert.equal((await get(port, route)).status, 502, route);
    });
  });
}
