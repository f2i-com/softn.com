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
    // What a private server bundle carries, deployed here by mistake as the
    // public client: its source must never reach a browser.
    'server/routes.logic': strToU8('route("/secret", () => DB_PASSWORD)'),
    'server/migrations/001.sql': strToU8('CREATE TABLE secrets (value TEXT);'),
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

/**
 * The tests rewrite `serve.config.php` and ask again at once. PHP's opcache
 * keeps a compiled file for `opcache.revalidate_freq` seconds (two by
 * default) once the file is two seconds old, so a run that took longer than
 * that was answered from the settings of the test before: five tests failed
 * on a busy machine and none on an idle one. The servers here run without
 * it; what the host does with its settings is the same either way.
 */
const FRESH = ['-d', 'opcache.enable=0'];

let root: string;
let server: ChildProcess | undefined;
let origin: string;
let cookie = '';

async function start(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(php, [...FRESH, '-S', `127.0.0.1:${port}`, '-t', join(root, 'webroot')], {
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
    const pub = fileURLToPath(new URL('../php/', import.meta.url));
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

  it('makes the page installable and gives links a card, with the manifest served without a cookie', async () => {
    const html = await (await fetch(`${origin}/`)).text();
    expect(html).toContain('<meta name="theme-color" content="#f5f5f8" />');
    expect(html).toContain('<link rel="manifest" href="/index.php?manifest">');
    expect(html).toContain('<meta name="application-name" content="Served &lt;Title&gt; &amp; &quot;Co&quot;">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(html).toContain('<meta property="og:title" content="Served &lt;Title&gt; &amp; &quot;Co&quot;">');
    expect(html).toContain('<meta property="og:description" content="A &quot;quoted&quot; description">');
    expect(html).toContain(`<meta property="og:url" content="${origin}/">`);
    expect(html).toContain(`<meta property="og:image" content="${origin}/share.png">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('navigator.serviceWorker.register("/sw.js")');
    const response = await fetch(`${origin}/index.php?manifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/manifest\+json/);
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      id: '/',
      name: 'Served <Title> & "Co"',
      short_name: 'Served <Title> & "Co"',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      theme_color: '#f5f5f8',
      background_color: '#f5f5f8',
      lang: 'en',
      description: 'A "quoted" description',
    });
    expect(manifest.icons).toEqual([
      { src: '/pwa-icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
    expect((await fetch(`${origin}/index.php?manifest`, { method: 'HEAD' })).status).toBe(200);
  });

  it('lets the operator tune the installable app, point previews at the public address, or turn it off', async () => {
    writeFileSync(
      join(root, 'private/serve.config.php'),
      config(
        `'pwa' => ['shortName' => 'Served', 'themeColor' => '#123456', 'orientation' => 'landscape', 'siteUrl' => 'https://example.test/app/', 'icons' => [['src' => 'my/icon.png', 'sizes' => '512x512', 'type' => 'image/png']], 'shareImage' => 'https://cdn.example.test/card.png', 'serviceWorker' => false],`
      )
    );
    let html = await (await fetch(`${origin}/`)).text();
    expect(html).toContain('<meta name="theme-color" content="#123456" />');
    expect(html).toContain('<meta name="application-name" content="Served">');
    expect(html).toContain('<meta property="og:url" content="https://example.test/app/">');
    expect(html).toContain('<meta property="og:image" content="https://cdn.example.test/card.png">');
    expect(html).not.toContain('serviceWorker.register');
    const manifest = await (await fetch(`${origin}/index.php?manifest`)).json();
    expect(manifest.short_name).toBe('Served');
    expect(manifest.orientation).toBe('landscape');
    expect(manifest.icons).toEqual([{ src: '/my/icon.png', sizes: '512x512', type: 'image/png' }]);
    writeFileSync(join(root, 'private/serve.config.php'), config(`'pwa' => false,`));
    html = await (await fetch(`${origin}/`)).text();
    expect(html).not.toContain('rel="manifest"');
    expect(html).not.toContain('og:title');
    expect(html).toContain('<meta name="theme-color" content="#f5f5f8" />');
    expect((await fetch(`${origin}/index.php?manifest`)).status).toBe(404);
    writeFileSync(join(root, 'private/serve.config.php'), config(`'pwa' => ['icons' => [['src' => '../evil.png', 'sizes' => '512x512']]],`));
    expect((await fetch(`${origin}/`)).status).toBe(503);
    writeFileSync(join(root, 'private/serve.config.php'), config());
  });

  it('cannot be framed by another site unless the operator lists it', async () => {
    // A page another site can frame can have its permission bar covered with a
    // look-alike and its Allow clicked for the visitor.
    let response = await fetch(`${origin}/`);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    writeFileSync(join(root, 'private/serve.config.php'), config(`'frameAncestors' => ['https://portal.example.com'],`));
    response = await fetch(`${origin}/`);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self' https://portal.example.com");
    expect(response.headers.get('x-frame-options')).toBeNull();
    writeFileSync(join(root, 'private/serve.config.php'), config(`'frameAncestors' => ["https://x.example.com; script-src *"],`));
    expect((await fetch(`${origin}/`)).status).toBe(503);
    writeFileSync(join(root, 'private/serve.config.php'), config());
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
    expect(JSON.stringify(pack)).not.toContain('server/');
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

  it('answers byte ranges inside a large entry, which is streamed rather than inflated into memory whole', async () => {
    const size = big.length;
    for (const [range, from, to] of [
      ['bytes=0-99', 0, 99],
      [`bytes=${5 * 1024 * 1024 + 7}-${5 * 1024 * 1024 + 70006}`, 5 * 1024 * 1024 + 7, 5 * 1024 * 1024 + 70006],
      [`bytes=${size - 1000}-`, size - 1000, size - 1],
      ['bytes=-4096', size - 4096, size - 1],
      [`bytes=${size - 10}-${size + 500}`, size - 10, size - 1],
    ] as const) {
      const response = await fetch(`${origin}/index.php?entry=media/big.bin`, {
        headers: withCookie({ Range: range }),
      });
      expect(response.status, range).toBe(206);
      expect(response.headers.get('content-range'), range).toBe(`bytes ${from}-${to}/${size}`);
      expect(response.headers.get('content-length'), range).toBe(String(to - from + 1));
      expect(new Uint8Array(await response.arrayBuffer()), range).toEqual(big.slice(from, to + 1));
    }
    const head = await fetch(`${origin}/index.php?entry=media/big.bin`, {
      method: 'HEAD',
      headers: withCookie({ Range: 'bytes=100-199' }),
    });
    expect(head.status).toBe(206);
    expect(head.headers.get('content-length')).toBe('100');
  });

  it('honours a range only when If-Range names the entry being served', async () => {
    const whole = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie(),
    });
    const etag = whole.headers.get('etag')!;
    const current = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie({ Range: 'bytes=10-19', 'If-Range': etag }),
    });
    expect(current.status).toBe(206);
    expect(new Uint8Array(await current.arrayBuffer())).toEqual(pixel.slice(10, 20));
    // A validator for some earlier build of the entry: the range is ignored
    // and the whole entry comes back, so the client does not splice bytes
    // of two different files together.
    const stale = await fetch(`${origin}/index.php?entry=images/pixel.png`, {
      headers: withCookie({ Range: 'bytes=10-19', 'If-Range': '"deadbeef-300"' }),
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('content-range')).toBeNull();
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(pixel);
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
    ['server/migrations/001.sql', "a private server bundle's file"],
    ['./server/migrations/001.sql', 'the same, spelled with ./'],
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

  it('cuts the short name and the description by characters, whatever bytes they take', async () => {
    // Twenty two-byte and twenty four-byte characters: forty characters in
    // the 120 bytes a title may be. The short name is its first thirty.
    const title = 'é'.repeat(20) + '😀'.repeat(20);
    // A bundle whose own description runs past the 300 characters a page
    // carries, in characters of three bytes.
    const described = zipSync({
      'manifest.json': strToU8(JSON.stringify({ ...manifest, icon: undefined, description: '☃'.repeat(400) })),
      'ui/main.ui': strToU8('<App><Text>Hi</Text></App>'),
    });
    writeFileSync(join(root, 'private/long.softn'), described);
    const settings = (lines: string) =>
      `<?php\nreturn [\n  'id' => 'served-test',\n  'bundle' => __DIR__ . '/long.softn',\n  ${lines}\n];\n`;
    try {
      writeFileSync(join(root, 'private/serve.config.php'), settings(`'title' => '${title}',`));
      let response = await fetch(`${origin}/index.php?manifest`);
      expect(response.status).toBe(200);
      let served = await response.json();
      expect(served.name).toBe(title);
      expect(served.short_name).toBe('é'.repeat(20) + '😀'.repeat(10));
      expect([...served.description]).toHaveLength(300);
      expect(served.description).toBe('☃'.repeat(300));
      expect(await (await fetch(`${origin}/`)).text()).toContain(
        `<meta name="description" content="${'☃'.repeat(300)}">`
      );
      // A short name of thirty characters is taken, however many bytes; one more is refused.
      writeFileSync(
        join(root, 'private/serve.config.php'),
        settings(`'title' => 'T', 'pwa' => ['shortName' => '${'😀'.repeat(30)}'],`)
      );
      expect((await (await fetch(`${origin}/index.php?manifest`)).json()).short_name).toBe('😀'.repeat(30));
      writeFileSync(
        join(root, 'private/serve.config.php'),
        settings(`'title' => 'T', 'pwa' => ['shortName' => '${'😀'.repeat(31)}'],`)
      );
      response = await fetch(`${origin}/`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('pwa.shortName must be 1 to 30 characters.');
      // Bytes that are no text become U+FFFD, on the page and in the manifest
      // alike, and are cut as the one character each then is.
      writeFileSync(
        join(root, 'private/serve.config.php'),
        settings(`'title' => "Caf\\xC3\\xA9 \\xFF\\xFE " . str_repeat("\\xE2\\x98\\x83", 30),`)
      );
      served = await (await fetch(`${origin}/index.php?manifest`)).json();
      expect(served.name).toBe('Café \uFFFD\uFFFD ' + '☃'.repeat(30));
      expect(served.short_name).toBe('Café \uFFFD\uFFFD ' + '☃'.repeat(22));
      expect(await (await fetch(`${origin}/`)).text()).toContain(
        `<meta name="application-name" content="${'Café \uFFFD\uFFFD ' + '☃'.repeat(22)}">`
      );
    } finally {
      writeFileSync(join(root, 'private/serve.config.php'), config());
      rmSync(join(root, 'private/long.softn'), { force: true });
    }
  });

  /**
   * A second PHP over the same deployment, started with settings of its own:
   * `-n` reads no php.ini, so it has only what is built in and what is named.
   */
  async function serve(args: string[]): Promise<{ origin: string; stop: () => void }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      const child = spawn(php, [...args, ...FRESH, '-S', `127.0.0.1:${port}`, '-t', join(root, 'webroot')], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let exited = false;
      child.on('exit', () => (exited = true));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !exited) {
        try {
          await fetch(`http://127.0.0.1:${port}/no-such-page`);
          return { origin: `http://127.0.0.1:${port}`, stop: () => child.kill() };
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      child.kill();
    }
    throw Error('PHP built-in server did not start');
  }
  /** What a PHP started with `args` has, of the things this host has ever asked for. */
  const has = (args: string[]) =>
    spawnSync(
      php,
      [...args, '-r', 'echo json_encode(["zip"=>class_exists("ZipArchive"),"mbstring"=>function_exists("mb_substr")]);'],
      { encoding: 'utf8' }
    );
  // zip alone, added to a PHP that reads no php.ini. Where zip is a shared
  // extension it has to be named (and found: Windows builds look in C:\php\ext
  // unless told); where it is built in, `-n` leaves it there.
  const extensionDir = spawnSync(php, ['-r', 'echo ini_get("extension_dir");'], { encoding: 'utf8' }).stdout.trim();
  const zipOnly = [['-n'], ['-n', '-d', `extension_dir=${extensionDir}`, '-d', 'extension=zip']].find((args) => {
    const probe = has(args);
    return probe.status === 0 && probe.stdout.includes('"zip":true');
  });

  it.skipIf(!zipOnly)(
    'serves on a PHP with the zip extension and no other, where the host disables ini_set, set_time_limit and ctype',
    async () => {
      // A stock Debian or Ubuntu PHP has no mbstring: this host answered every
      // request "503 Enable the PHP mbstring extension" there, for a short name
      // and a description. A shared host that disables ini_set or
      // set_time_limit got a blank 500 from the unguarded calls at the top of
      // the file, and one without ctype a fatal error wherever the viewer
      // cookie was read.
      const bare = await serve([...zipOnly!, '-d', 'disable_functions=ini_set,set_time_limit,ctype_digit']);
      try {
        const page = await fetch(`${bare.origin}/`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('<title>Served &lt;Title&gt; &amp; &quot;Co&quot;</title>');
        const viewer = (page.headers.get('set-cookie') ?? '').split(';')[0];
        expect(viewer).toMatch(/^softn_viewer=1\./);
        const installable = await fetch(`${bare.origin}/index.php?manifest`);
        expect(installable.status).toBe(200);
        expect((await installable.json()).short_name).toBe('Served <Title> & "Co"');
        // The cookie is read here: its expiry was checked with ctype_digit().
        const pack = await fetch(`${bare.origin}/index.php?source`, { headers: { Cookie: viewer } });
        expect(pack.status).toBe(200);
        expect(Object.keys((await pack.json()).text)).toContain('ui/main.ui');
        const image = await fetch(`${bare.origin}/index.php?entry=images/pixel.png`, { headers: { Cookie: viewer } });
        expect(image.status).toBe(200);
        expect(new Uint8Array(await image.arrayBuffer())).toEqual(pixel);
        // A cookie whose expiry is no number is still refused, by the same check.
        const forged = viewer.replace(/^softn_viewer=1\.\d+\./, 'softn_viewer=1.12x4.');
        expect((await fetch(`${bare.origin}/index.php?source`, { headers: { Cookie: forged } })).status).toBe(403);
      } finally {
        bare.stop();
      }
    }
  );

  const noZip = has(['-n']);
  it.skipIf(noZip.status !== 0 || !noZip.stdout.includes('"zip":false'))(
    'says which extension is missing, and which package has it, on a PHP without zip',
    async () => {
      // The one extension this host cannot do without. The message named the
      // extension; on the stock PHP that lacks it the operator needs the package.
      const bare = await serve(['-n']);
      try {
        const response = await fetch(`${bare.origin}/`);
        expect(response.status).toBe(503);
        const said = await response.text();
        expect(said).toMatch(/^Enable the PHP zip extension/);
        expect(said).toContain('php-zip');
      } finally {
        bare.stop();
      }
    }
  );

  // php-cgi, the SAPI a web server hands requests to, takes what the server
  // says of the request from its environment; `php -S` decides it all itself.
  const cgiAvailable = (() => {
    const probe = spawnSync('php-cgi', ['-m'], { encoding: 'utf8' });
    return probe.status === 0 && /^zip$/m.test(probe.stdout.replace(/\r/g, ''));
  })();
  it.skipIf(!cgiAvailable)(
    'refuses a private directory beside the page whatever the server calls its document root',
    () => {
      // A site mounted with Alias, or a user directory: DOCUMENT_ROOT is the
      // main site's, somewhere else. Only DOCUMENT_ROOT was looked at, so a
      // private directory put beside index.php passed the check, with the
      // archive and the cookie secret on a URL wherever .htaccess is not read.
      const site = mkdtempSync(join(tmpdir(), 'softn-serve-mounted-'));
      try {
        mkdirSync(join(site, 'elsewhere'));
        mkdirSync(join(site, 'mounted/private'), { recursive: true });
        cpSync(fileURLToPath(new URL('../php/softn-serve.php', import.meta.url)), join(site, 'mounted/softn-serve.php'));
        writeFileSync(
          join(site, 'mounted/index.php'),
          "<?php\n$private = __DIR__ . '/private';\nrequire __DIR__ . '/softn-serve.php';\n"
        );
        writeFileSync(join(site, 'mounted/private/app.softn'), bundle);
        writeFileSync(
          join(site, 'mounted/private/shell.html'),
          shellTemplate('<script type="module" crossorigin src="./assets/index-test.js"></script>')
        );
        const ask = (extra = '') => {
          writeFileSync(join(site, 'mounted/private/serve.config.php'), config(extra));
          const r = spawnSync('php-cgi', [], {
            encoding: 'utf8',
            env: {
              ...process.env,
              REQUEST_METHOD: 'GET',
              REQUEST_URI: '/~someone/index.php',
              SCRIPT_NAME: '/~someone/index.php',
              SCRIPT_FILENAME: join(site, 'mounted/index.php'),
              DOCUMENT_ROOT: join(site, 'elsewhere'),
              REDIRECT_STATUS: '200',
              GATEWAY_INTERFACE: 'CGI/1.1',
              SERVER_PROTOCOL: 'HTTP/1.1',
              HTTP_HOST: 'site.example',
            },
          });
          const [head, body = ''] = r.stdout.split(/\r?\n\r?\n/, 2);
          return { status: Number(head.match(/^Status: (\d+)/m)?.[1] ?? '200'), body };
        };
        const refused = ask();
        expect(refused.status).toBe(503);
        expect(refused.body).toBe('The private directory must be outside the public document root.');
        // The operator who means it says so, as before.
        expect(ask(`'allowPrivateInWebroot' => true,`).status).toBe(200);
      } finally {
        rmSync(site, { recursive: true, force: true });
      }
    }
  );
});
