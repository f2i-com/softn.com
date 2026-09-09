/**
 * The host, end to end: PHP's built-in server over a temporary deployment
 * laid out the way the archive is — webroot/ beside private/ — with a bundle
 * that has text, an icon, a small image, a withheld file and a large binary.
 * Skipped where `php` is not on PATH; CI installs php-cli for the other
 * PHP host's checks.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shellTemplate } from '../scripts/shell.mjs';

const php = process.env.PHP || 'php';
const available = (() => {
  const probe = spawnSync(php, ['-r', 'echo class_exists("ZipArchive") ? "zip" : "nozip";'], {
    encoding: 'utf8',
  });
  return probe.status === 0 && probe.stdout.trim() === 'zip';
})();

const pixel = new Uint8Array(300).map((_, i) => (i * 7) % 256);
const big = new Uint8Array(9 * 1024 * 1024).map((_, i) => (i * 31 + (i >> 8)) % 256);
const icon = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const manifest = {
  name: 'Served <example>',
  version: '1.0.0',
  description: 'A "quoted" description',
  main: 'ui/main.ui',
  icon: 'images/icon.png',
  files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets: ['images/pixel.png'] },
  config: { execution: 'worker', server: { url: 'https://sync.example', token: 'SECRET-TOKEN' } },
};
const bundle = zipSync(
  {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'permission.json': strToU8('{"permissions":{}}'),
    'ui/main.ui': strToU8('<logic src="../logic/main.logic" />\n<App><Text>Hi</Text></App>'),
    'logic/main.logic': strToU8('let n = 0'),
    'data/levels.json': strToU8('{"levels":[1]}'),
    'README.md': strToU8('# private notes'),
    'images/icon.png': icon,
    'images/pixel.png': pixel,
    'media/big.bin': [big, { level: 0 }],
  },
  { level: 6 }
);
const bundleDigest = createHash('sha256').update(bundle).digest('hex');

function config(extra = '') {
  return `<?php
return [
  'id' => 'served-test',
  'title' => 'Served <Title> & "Co"',
  'bundle' => __DIR__ . '/app.softn',
  'theme' => 'light',
  'loadingText' => 'One moment…',
  'withhold' => ['README.md'],
  'cacheSeconds' => 60,
  ${extra}
];
`;
}

let root: string;
let server: ChildProcess | undefined;
let origin: string;
let cookie = '';

async function start(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', join(root, 'webroot')], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !exited) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/index.php`, {
          headers: { 'Sec-Fetch-Mode': 'navigate' },
        });
        if (response.status > 0) {
          server = child;
          origin = `http://127.0.0.1:${port}`;
          return;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    child.kill();
  }
  throw Error('PHP built-in server did not start');
}

const withCookie = (headers: Record<string, string> = {}) => ({ Cookie: cookie, ...headers });

/** A request with headers exactly as given, which fetch would not send. */
function rawStatus(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const request = http.request(
      { host: url.hostname, port: url.port, path, headers },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.on('error', reject);
    request.end();
  });
}

describe.skipIf(!available)('softn-serve over php -S', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'softn-serve-'));
    mkdirSync(join(root, 'webroot'));
    mkdirSync(join(root, 'private'));
    const pub = fileURLToPath(new URL('../public/', import.meta.url));
    for (const name of ['index.php', 'softn-serve.php'])
      cpSync(join(pub, name), join(root, 'webroot', name));
    writeFileSync(join(root, 'private/app.softn'), bundle);
    writeFileSync(join(root, 'private/serve.config.php'), config());
    writeFileSync(
      join(root, 'private/shell.html'),
      shellTemplate('<script type="module" crossorigin src="./assets/index-test.js"></script>')
    );
    await start();
  });
  afterAll(() => {
    server?.kill();
    rmSync(root, { recursive: true, force: true });
  });

  it('renders the shell on the server with escaped settings, the icon link and the boot JSON', async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('<title>Served &lt;Title&gt; &amp; &quot;Co&quot;</title>');
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toContain('background: #f5f5f8;');
    expect(html).toContain('<meta name="description" content="A &quot;quoted&quot; description">');
    expect(html).toContain('<link rel="icon" href="/index.php?icon" type="image/png">');
    expect(html).toContain('<span>One moment…</span>');
    expect(html).toContain(
      '<script type="module" crossorigin src="./assets/index-test.js"></script>'
    );
    const boot = html.match(/<script id="softn-boot" type="application\/json">(.*?)<\/script>/);
    expect(boot).not.toBeNull();
    expect(JSON.parse(boot![1])).toEqual({
      version: 1,
      endpoint: '/index.php',
      loadingText: 'One moment…',
    });
    const set = response.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^softn_viewer=1\.\d+\.[a-f0-9]{16}\.[a-f0-9]{32};/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/path=\//i);
    cookie = set.split(';')[0];
  });

  it('answers HEAD for the page without a body', async () => {
    const response = await fetch(`${origin}/index.php`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('refuses the source pack without the viewer cookie', async () => {
    const response = await fetch(`${origin}/index.php?source`);
    expect(response.status).toBe(403);
  });

  it('refuses a forged or expired cookie', async () => {
    const forged = cookie.replace(/\.[a-f0-9]{32}$/, '.' + '0'.repeat(32));
    expect(
      (await fetch(`${origin}/index.php?source`, { headers: { Cookie: forged } })).status
    ).toBe(403);
    const expired = cookie.replace(/=1\.\d+\./, '=1.1000.');
    expect(
      (await fetch(`${origin}/index.php?source`, { headers: { Cookie: expired } })).status
    ).toBe(403);
  });

  it('serves the source pack: text entries, entry names and a sanitized manifest', async () => {
    const response = await fetch(`${origin}/index.php?source`, { headers: withCookie() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const pack = await response.json();
    expect(pack.version).toBe(1);
    expect(pack.id).toBe('served-test');
    expect(pack.title).toBe('Served <Title> & "Co"');
    expect(pack.theme).toBe('light');
    expect(pack.permissionMode).toBe('prompt');
    expect(pack.digest).toBe(bundleDigest);
    expect(pack.declared).toBeNull();
    expect(Object.keys(pack.text).sort()).toEqual([
      'data/levels.json',
      'logic/main.logic',
      'permission.json',
      'ui/main.ui',
    ]);
    expect(pack.text['logic/main.logic']).toBe('let n = 0');
    expect(pack.entries).toEqual({
      'images/icon.png': icon.length,
      'images/pixel.png': pixel.length,
      'media/big.bin': big.length,
    });
    expect(pack.manifest).toEqual({
      name: 'Served <example>',
      version: '1.0.0',
      description: 'A "quoted" description',
      main: 'ui/main.ui',
      icon: 'images/icon.png',
      files: manifest.files,
      config: { execution: 'worker' },
    });
    expect(JSON.stringify(pack)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(pack)).not.toContain('private notes');
  });

  it('serves a binary entry with its MIME type, an ETag and a private cache policy', async () => {
    const response = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(pixel.length));
    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    const etag = response.headers.get('etag');
    expect(etag).toMatch(/^"[a-f0-9]+-300"$/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pixel);
    const cached = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie({ 'If-None-Match': etag! }),
    });
    expect(cached.status).toBe(304);
  });

  it('answers byte ranges for media', async () => {
    const response = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie({ Range: 'bytes=10-19' }),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 10-19/300');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pixel.slice(10, 20));
    const tail = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie({ Range: 'bytes=-5' }),
    });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(pixel.slice(295));
    const bad = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie({ Range: 'bytes=400-500' }),
    });
    expect(bad.status).toBe(416);
  });

  it('streams a large entry intact', async () => {
    const response = await fetch(`${origin}/index.php?entry=media/big.bin`, {
      headers: withCookie(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(big.length);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      createHash('sha256').update(big).digest('hex')
    );
  });

  it('serves the manifest icon', async () => {
    const response = await fetch(`${origin}/index.php?icon`, { headers: withCookie() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(icon);
  });

  it.each([
    ['ui/main.ui', 'a text entry, which travels in the pack'],
    ['manifest.json', 'the raw manifest'],
    ['README.md', 'a withheld entry'],
    ['../private/app.softn', 'a traversal'],
    ['/etc/passwd', 'an absolute path'],
    ['images/missing.png', 'a missing entry'],
    ['images/', 'a directory'],
  ])('answers 404 for %s (%s)', async (name) => {
    const response = await fetch(`${origin}/index.php?entry=${encodeURIComponent(name)}`, {
      headers: withCookie(),
    });
    expect(response.status).toBe(404);
  });

  it('refuses a browser navigation and a cross-site fetch even with the cookie', async () => {
    // Node's fetch rewrites Sec-Fetch-* itself (they are forbidden request
    // headers), so these go out as raw HTTP requests.
    const cases: Record<string, string>[] = [
      { 'Sec-Fetch-Mode': 'navigate' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of cases) {
      for (const query of ['source', 'entry=images/pixel.png', 'icon']) {
        const status = await rawStatus(`/index.php?${query}`, withCookie(headers));
        expect(status, `${query} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
  });

  it('puts nothing of the archive on a URL', async () => {
    // Apache answers 404 for a path that is not a file; PHP's built-in server
    // hands every unknown path to index.php, which must answer 404 itself.
    for (const path of [
      '/app.softn',
      '/private/app.softn',
      '/../private/app.softn',
      '/serve.config.php',
      '/secret.key',
    ]) {
      const response = await fetch(`${origin}${path}`, { headers: withCookie() });
      expect(response.status, path).toBe(404);
      expect((await response.text()).startsWith('PK'), path).toBe(false);
    }
  });

  it('refuses methods other than GET and HEAD', async () => {
    const response = await fetch(`${origin}/index.php?source`, {
      method: 'POST',
      headers: withCookie(),
    });
    expect(response.status).toBe(405);
  });

  it('serves without a cookie when the operator turns the viewer token off', async () => {
    writeFileSync(join(root, 'private/serve.config.php'), config(`'viewerToken' => false,`));
    try {
      const response = await fetch(`${origin}/index.php?source`);
      expect(response.status).toBe(200);
    } finally {
      writeFileSync(join(root, 'private/serve.config.php'), config());
    }
  });

  it('pins the bundle digest and requires it for preapproved permissions', async () => {
    writeFileSync(
      join(root, 'private/serve.config.php'),
      config(`'permissionMode' => 'preapproved',`)
    );
    try {
      expect((await fetch(`${origin}/index.php?source`, { headers: withCookie() })).status).toBe(
        503
      );
      writeFileSync(
        join(root, 'private/serve.config.php'),
        config(`'permissionMode' => 'preapproved', 'sha256' => '${'0'.repeat(64)}',`)
      );
      expect((await fetch(`${origin}/index.php?source`, { headers: withCookie() })).status).toBe(
        503
      );
      writeFileSync(
        join(root, 'private/serve.config.php'),
        config(`'permissionMode' => 'preapproved', 'sha256' => '${bundleDigest}',`)
      );
      const response = await fetch(`${origin}/index.php?source`, { headers: withCookie() });
      expect(response.status).toBe(200);
      expect((await response.json()).permissionMode).toBe('preapproved');
    } finally {
      writeFileSync(join(root, 'private/serve.config.php'), config());
    }
  });

  it('sends an operator sidecar as the declaration', async () => {
    writeFileSync(
      join(root, 'private/permission.json'),
      '{"permissions":{"camera":{"enabled":true}}}'
    );
    writeFileSync(
      join(root, 'private/serve.config.php'),
      config(`'permissions' => __DIR__ . '/permission.json',`)
    );
    try {
      const response = await fetch(`${origin}/index.php?source`, { headers: withCookie() });
      expect((await response.json()).declared).toEqual({
        permissions: { camera: { enabled: true } },
      });
    } finally {
      writeFileSync(join(root, 'private/serve.config.php'), config());
    }
  });

  it('reports an unknown setting instead of guessing', async () => {
    writeFileSync(join(root, 'private/serve.config.php'), config(`'downloadable' => true,`));
    try {
      const response = await fetch(`${origin}/`);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('downloadable');
    } finally {
      writeFileSync(join(root, 'private/serve.config.php'), config());
    }
  });

  it('keeps the generated secret in the private directory', () => {
    expect(readFileSync(join(root, 'private/secret.key'), 'utf8').trim()).toMatch(/^[a-f0-9]{64}$/);
  });
});
