/**
 * Regression test suite for the SoftN Container v2 Audit.
 *
 * Covers security/sandbox hardening, source-map accuracy, async error capture,
 * subdirectory/root/directory navigation, ESM diamond & syntax edge cases,
 * JSX/TSX transforms, storage/IDB consistency, and backend isolation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ContainerArchive,
  RemoteBackendTransport,
  SoftNContainerError,
  mountSoftNContainer,
} from '../src/index';
import { extractFontFaces, namespaceContainerFonts, rewriteCss } from '../src/css-policy';
import { hostAttributeValue, hostElementName, isDeclaredElementProperty } from '../src/host-policy';
import { evaluateHtaccessChain, parseHtaccess } from '../src/htaccess';
import { isAllowedExternalVendorModule, resolveModuleSpecifier, transformEsModule } from '../src/esm-linker';
import { VirtualCookieJar } from '../src/backend-transport';
import { transformJsx } from '../src/jsx-transform';
import { SourceMapRegistry, findInlineScriptStartLines } from '../src/source-map';
import { containerRuntimeNeeds } from '../src/runtime-needs';
import { mimeTypeFor } from '../src/archive';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PKG_ROOT = path.resolve(__dirname, '..');
const LITE_WASM = new Uint8Array(
  fs.readFileSync(path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm'))
);

async function settle(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string) {
      return map.get(String(k)) ?? null;
    },
    setItem(k: string, v: string) {
      map.set(String(k), String(v));
    },
    removeItem(k: string) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
  };
}

describe('SoftN v2 Audit — Security & Sandbox Hardening', () => {
  it('blocks <softn-app> and arbitrary host-registered custom elements while keeping allowlisted extensions and guest tags', () => {
    expect(hostElementName('softn-app')).toBeNull();
    expect(hostElementName('SOFTN-APP')).toBeNull();
    expect(hostElementName('svg:softn-app', 'svg')).toBeNull();

    // Host-defined custom element outside SoftN allowlist must be rejected.
    class HostSecretWidget extends HTMLElement {}
    if (!customElements.get('host-secret-widget')) {
      customElements.define('host-secret-widget', HostSecretWidget);
    }
    expect(hostElementName('host-secret-widget')).toBeNull();

    // Allowlisted SoftN UI extensions and unregistered guest custom elements remain permitted.
    expect(hostElementName('softn-chart')).toBe('softn-chart');
    expect(hostElementName('softn-datagrid')).toBe('softn-datagrid');
    expect(hostElementName('guest-unregistered-card')).toBe('guest-unregistered-card');
  });

  it('neutralizes CSS image-set var()/env()/attr() exfiltration while keeping type() MIME strings', () => {
    const mapUrl = (addr: string) => (addr === 'pic.png' ? 'blob:safe-pic' : null);
    const out = rewriteCss(
      [
        '.a { background-image: image-set(var(--x, "https://attacker.example/exfil") 1x); }',
        '.b { --u: "https://attacker.example/u"; background-image: image-set(var(--u) 1x); }',
        '.c { background-image: image-set(env(safe-url, "https://attacker.example/e") 1x); }',
        '.d { background-image: image-set("pic.png" type("image/png") 1x, "https://attacker.example/bad.png" 2x); }',
        '.e { --v: url("https://attacker.example/v"); background-image: var(--v); }',
      ].join('\n'),
      mapUrl
    );
    const lines = out.split('\n');
    expect(lines[0]).toContain('image-set(url("about:blank") 1x)');
    expect(lines[0]).not.toContain('attacker.example');
    expect(lines[1]).toContain('image-set(url("about:blank") 1x)');
    expect(lines[1]).not.toContain('var(--u)');
    expect(lines[2]).toContain('image-set(url("about:blank") 1x)');
    expect(lines[2]).not.toContain('attacker.example');
    expect(lines[3]).toContain('"blob:safe-pic" type("image/png") 1x');
    expect(lines[3]).not.toContain('attacker.example');
    expect(lines[4]).not.toContain('attacker.example');
  });

  it('blocks srcset trailing-comma URL smuggling and SVG animation filter/href bypasses', async () => {
    const archive = await ContainerArchive.open({
      'index.html': '<!doctype html><html><body></body></html>',
      'empty.svg': '',
      'ok.png': new Uint8Array([137, 80, 78, 71]),
    });
    const ctx = {
      entryPath: 'index.html',
      archive,
      permissions: { permissions: {} },
      netGranted: false,
    };

    // Empty SVG must never mint a trailing-comma data URL.
    const emptySvgUrl = archive.getBlobUrl('empty.svg');
    expect(emptySvgUrl).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
    expect(emptySvgUrl?.endsWith(',')).toBe(false);

    // Trailing-comma / multi-token descriptor smuggling in srcset must be dropped.
    const smuggled = hostAttributeValue(
      'img',
      'srcset',
      'empty.svg https://attacker.example/exfil 2x, ok.png 1x',
      ctx
    );
    expect(smuggled).not.toContain('attacker.example');
    expect(smuggled).toContain('1x');

    // SVG <set> targeting filter/mask/href or containing url(https://...) is neutralized.
    expect(hostAttributeValue('set', 'attributeName', 'filter', { ...ctx, ns: 'svg' })).toBeNull();
    expect(hostAttributeValue('set', 'attributeName', 'xlink:href', { ...ctx, ns: 'svg' })).toBeNull();
    expect(hostAttributeValue('set', 'attributeName', 'style', { ...ctx, ns: 'svg' })).toBeNull();
    const animTo = hostAttributeValue('set', 'to', 'u\\72l(https://attacker.example/f)', { ...ctx, ns: 'svg' });
    expect(animTo).not.toContain('attacker.example');
    expect(animTo).toContain('about:blank');

    // Normal SVG transform animation remains intact.
    expect(hostAttributeValue('animateTransform', 'to', 'rotate(360 50 50)', { ...ctx, ns: 'svg' })).toBe(
      'rotate(360 50 50)'
    );

    archive.dispose();
  });

  it('hardens ContainerArchive MIME/path checks and partitions backend-private paths', async () => {
    expect(mimeTypeFor('evil.constructor')).toBe('application/octet-stream');
    expect(mimeTypeFor('evil.toString')).toBe('application/octet-stream');

    const archive = await ContainerArchive.open({
      'manifest.json': JSON.stringify({
        name: 'Fullstack',
        engine: 2,
        main: 'index.html',
        backend: { runtime: 'javascript', entry: 'backend/server.js', routes: ['/api/'] },
      }),
      'index.html': '<!doctype html><html><body>hi</body></html>',
      '../escape.txt': 'nope',
      'backend/server.js': 'function handleRequest() { return { status: 200, body: "ok" }; }',
      'server/secret.js': 'const SECRET = 1;',
      'private/key.txt': 'top-secret',
      '.git/config': '[core]',
      'db/seed.json': '{"users":[]}',
    });

    expect(archive.has('../escape.txt')).toBe(false);
    const feVfs = archive.exportFrontendVfs();
    expect(feVfs.textFiles['index.html']).toBeDefined();
    expect(feVfs.textFiles['backend/server.js']).toBeUndefined();
    expect(feVfs.textFiles['server/secret.js']).toBeUndefined();
    expect(feVfs.textFiles['private/key.txt']).toBeUndefined();
    expect(feVfs.textFiles['.git/config']).toBeUndefined();
    expect(feVfs.textFiles['db/seed.json']).toBeUndefined();

    // Active XML/document runtime blobs must be downgraded to inert octet-stream.
    expect(archive.putRuntimeBlob('math1', 'application/mathml+xml', new TextEncoder().encode('<math/>'))).toBe(true);
    const mathUrl = archive.getRuntimeBlobUrl('math1');
    expect(mathUrl).toMatch(/^blob:/);
    const mathBlob = await (await fetch(mathUrl!)).blob();
    expect(mathBlob.type).toBe('application/octet-stream');

    archive.dispose();
  });

  it('enforces RemoteBackendTransport SSRF path validation and header precedence', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const transport = new RemoteBackendTransport({
        baseUrl: 'https://api.example.test/app',
        headers: { Authorization: 'Bearer trusted-host-token', 'X-Host-Id': 'host-1' },
      });

      await expect(transport.fetch({ method: 'GET', path: '//evil.example/steal' })).rejects.toThrow();
      await expect(transport.fetch({ method: 'GET', path: '/../admin' })).rejects.toThrow();
      await expect(transport.fetch({ method: 'GET', path: '/%2e%2e/admin' })).rejects.toThrow();

      await transport.fetch({
        method: 'GET',
        path: '/api/items',
        headers: {
          authorization: 'Bearer spoofed',
          'x-formlogic-user-id': 'admin',
          'x_formlogic_user_id': 'admin',
          'x-custom': 'allowed',
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const hdrs = init.headers as Record<string, string>;
      expect(hdrs['authorization']).toBe('Bearer trusted-host-token');
      expect(hdrs['x-host-id']).toBe('host-1');
      expect(hdrs['x-formlogic-user-id']).toBeUndefined();
      expect(hdrs['x_formlogic_user_id']).toBeUndefined();
      expect(hdrs['x-custom']).toBe('allowed');
      transport.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hardens .htaccess path traversal, trailing-slash <FilesMatch>, and nested-quantifier ReDoS', () => {
    const rootHt = parseHtaccess(
      `<FilesMatch "\\.(ini|env)$">\nDeny from all\n</FilesMatch>\nRewriteEngine On\nRewriteRule ^((a+)+)$ /boom [L]\n`,
      ''
    );
    const map = new Map([['', rootHt]]);
    const vfs = {
      isFile: (p: string) => p === 'config.ini' || p === 'sub/secret.env',
      isDir: (p: string) => p === 'sub',
    };

    expect(evaluateHtaccessChain(map, { pathname: '/config.ini/', query: '', method: 'GET' }, vfs)).toEqual({
      action: 'deny',
      status: 403,
    });
    expect(evaluateHtaccessChain(map, { pathname: '/config.ini/extra', query: '', method: 'GET' }, vfs)).toEqual({
      action: 'deny',
      status: 403,
    });
    expect(evaluateHtaccessChain(map, { pathname: '/sub/../config.ini', query: '', method: 'GET' }, vfs)).toEqual({
      action: 'deny',
      status: 403,
    });
    // Catastrophic nested quantifier rule was rejected during parse.
    expect(rootHt.rules).toHaveLength(0);
  });

  it('excludes backend files when computing frontend containerRuntimeNeeds', async () => {
    const needs = await containerRuntimeNeeds({
      'manifest.json': JSON.stringify({
        name: 'App',
        engine: 2,
        main: 'index.html',
        backend: { runtime: 'python', entry: 'backend/server.py', routes: ['/api/'] },
      }),
      'index.html': '<!doctype html><html><body><script>document.title = "plain";</script></body></html>',
      'backend/server.py': 'import torch\ndef handle_request(req): return {"status": 200}',
    });
    expect(needs.tiers).toContain('lite');
    expect(needs.tiers).toContain('python');
    expect(needs.tiers).not.toContain('python-torch');
  });
});

describe('SoftN v2 Audit — Source Maps, ESM Linker & JSX Transform', () => {
  it('does not corrupt zipp:preamble frames or timestamps and honors isEval: false', () => {
    const map = new SourceMapRegistry();
    map.addSegment({
      file: 'src/app.js',
      combinedStart: 500,
      combinedEnd: 510,
      sourceStartLine: 1,
      wrapperLines: 1,
      sourceText: 'const a = 1;\nthrow new Error("boom");',
    });

    const err = new Error('Event failed at 10:05:30');
    err.stack = 'Error: Event failed at 10:05:30\n    at __zResolve (zipp:preamble:1:24)\n    at run (:502:7)';
    const enriched = map.enrichError(err, { file: 'index.html', startLine: 10, sourceText: 'x\ny', isEval: false });
    expect(enriched.file).toBe('src/app.js');
    expect(enriched.line).toBe(2);
    expect(enriched.message).toContain('10:05:30');
    expect(enriched.stack).toContain('zipp:preamble:1:24');
    expect(enriched.stack).toContain('src/app.js:2:7');
  });

  it('findInlineScriptStartLines ignores inert elements and quoted attribute strings', () => {
    const html = [
      '<!doctype html>',
      '<html><body>',
      '<div data-x="<!--"><textarea><script>nope()</script></textarea></div>',
      '<template><script>ignored()</script></template>',
      '<style>/* <script>nope()</script> */</style>',
      '<script>',
      '  const real = 1;',
      '</script>',
      '</body></html>',
    ].join('\n');
    expect(findInlineScriptStartLines(html)).toEqual([6]);
  });

  it('handles ++/--, export default regex, template ${import.meta.url}, multi-line imports, TS exports, and longest importMap prefix', () => {
    const src = [
      'import {',
      '  alpha,',
      '  "weird-name" as weird',
      '} from "./dep.js" with { type: "json" };',
      'import type, { beta } from "./types-val.js";',
      'export type * from "./only-types.ts";',
      'export abstract class Base {}',
      'export { alpha as "public-alpha" } from "./dep.js" with { type: "json" };',
      'const ratio = a++ / b;',
      'const u = `${import.meta.url}/asset.png`;',
      'export default /foo\\/bar/g;',
    ].join('\n');

    const res = transformEsModule(src, 'https://app.softn.local/src/main.ts');
    expect(res.factoryCode).toContain('const ratio = a++ / b;');
    expect(res.factoryCode).toContain('`${__meta.url}/asset.png`');
    expect(res.factoryCode).toContain('const type = __softn_m1.default;');
    expect(res.factoryCode).toContain('abstract class Base');
    expect(res.factoryCode).toContain('"public-alpha"');
    expect(res.factoryCode).toContain('"weird-name"');
    expect(res.factoryCode).toContain('const __softn_default = /foo\\/bar/g;');
    expect(res.factoryCode).not.toContain('only-types.ts');

    // Line-number preservation: `const u =` must stay on the same 1-based body line!
    const origLineIdx = src.split('\n').findIndex((l) => l.includes('const u ='));
    const bodyLines = res.factoryCode.split('\n').slice(res.headerLines ?? 0);
    const outLineIdx = bodyLines.findIndex((l) => l.includes('const u ='));
    expect(outLineIdx).toBe(origLineIdx);

    // Longest-prefix match in importMap
    const resolved = resolveModuleSpecifier('pkg/sub/file.js', 'index.html', {
      'pkg/': './shallow/',
      'pkg/sub/': './deep/',
    });
    expect(resolved).toEqual({
      kind: 'vfs',
      path: 'deep/file.js',
      url: 'https://app.softn.local/deep/file.js',
    });
  });

  it('transforms JSX edge cases: trailing // in {}, <Comp<T> />, <const T>, a++ < b, and backslash attrs', () => {
    const input = [
      'const id = <const T>(x: T) => x;',
      'const cmp = a++ < b ? 1 : 2;',
      'const el = <Table<Row> title="C:\\path\\">{value // trailing note\n}</Table>;',
    ].join('\n');
    const out = transformJsx(input);
    expect(out).toContain('const id = <const T>(x: T) => x;');
    expect(out).toContain('const cmp = a++ < b ? 1 : 2;');
    expect(out).toContain('globalThis.__softnJsx(Table, { title: "C:\\\\path\\\\" }, value // trailing note\n)');
    // Output must be valid JS after stripping TS generic on line 1
    expect(() => new Function('Table', 'value', 'a', 'b', out.replace('<const T>(x: T)', '(x)'))).not.toThrow();
  });
});

describe('SoftN v2 Audit — End-to-End Runtime, Navigation, Storage & IDB', () => {
  it('resolves diamond concurrent ES module imports without returning empty {}', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      source: {
        'shared.js': 'await Promise.resolve(); export const VALUE = 42;',
        'a.js': 'import { VALUE } from "./shared.js"; export const fromA = VALUE + 1;',
        'b.js': 'import { VALUE } from "./shared.js"; export const fromB = VALUE + 2;',
        'index.html': `<!doctype html><html><body><p id="out"></p><script type="module">
          const [a, b] = await Promise.all([import('./a.js'), import('./b.js')]);
          document.getElementById('out').textContent = a.fromA + ':' + b.fromB;
        </script></body></html>`,
      },
    });
    await settle(150);
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('43:44');
    handle.dispose();
  });

  it('captures async event-handler rejections and setInterval throws with exact line numbers without stopping setInterval', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const errors: Error[] = [];
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      onError: (err) => errors.push(err),
      source: {
        'index.html': [
          '<!doctype html><html><body>',
          '<button id="btn">Go</button><p id="ticks">0</p>',
          '<script>',
          'var n = 0;',
          'var iv = setInterval(function () {',
          '  n++;',
          '  document.getElementById("ticks").textContent = String(n);',
          '  if (n === 1) throw new Error("tick1-boom");',
          '  if (n >= 2) clearInterval(iv);',
          '}, 15);',
          'document.getElementById("btn").addEventListener("click", async function () {',
          '  await Promise.resolve();',
          '  throw new Error("async-click-boom");',
          '});',
          '</script></body></html>',
        ].join('\n'),
      },
    });
    (handle.shadowRoot.querySelector('#btn') as HTMLButtonElement).click();
    await settle(180);
    // setInterval survived the throw on tick 1 and reached tick 2.
    expect(handle.shadowRoot.querySelector('#ticks')?.textContent).toBe('2');
    expect(errors.some((e) => e.message.includes('tick1-boom'))).toBe(true);
    expect(errors.some((e) => e.message.includes('async-click-boom'))).toBe(true);
    expect(errors.some((e) => e instanceof SoftNContainerError && e.phase === 'unhandledrejection')).toBe(true);
    handle.dispose();
  });

  it('navigates subdirectory links, root "/", "/docs/", and preserves ?query#hash without double-prefixing', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': '<!doctype html><html><body><h1 id="p">home</h1><a id="to-docs" href="/docs/">docs</a></body></html>',
        'docs/index.html': '<!doctype html><html><body><h1 id="p">docs-index</h1><a id="to-other" href="other.html?tab=2#sec">other</a></body></html>',
        'docs/other.html': '<!doctype html><html><body><h1 id="p">docs-other</h1><p id="loc"></p><a id="to-home" href="/">home</a><script>document.getElementById("loc").textContent = location.pathname + location.search + location.hash;</script></body></html>',
      },
    });
    await settle(80);
    expect(handle.shadowRoot.querySelector('#p')?.textContent).toBe('home');

    (handle.shadowRoot.querySelector('#to-docs') as HTMLAnchorElement).click();
    await settle(100);
    expect(handle.shadowRoot.querySelector('#p')?.textContent).toBe('docs-index');

    (handle.shadowRoot.querySelector('#to-other') as HTMLAnchorElement).click();
    await settle(100);
    expect(handle.shadowRoot.querySelector('#p')?.textContent).toBe('docs-other');
    expect(handle.shadowRoot.querySelector('#loc')?.textContent).toBe('/docs/other.html?tab=2#sec');

    (handle.shadowRoot.querySelector('#to-home') as HTMLAnchorElement).click();
    await settle(100);
    expect(handle.shadowRoot.querySelector('#p')?.textContent).toBe('home');

    handle.dispose();
  });

  it('honors custom options.storage, keeps deleted localStorage keys deleted, and supports :root CSS variables', async () => {
    const customStorage = createMemoryStorage();
    const mountOnce = async (script: string) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const handle = await mountSoftNContainer(host, {
        appId: 'audit-storage-test',
        isolation: 'inline',
        storage: customStorage,
        engineWasm: { lite: LITE_WASM },
        source: {
          'index.html': `<!doctype html><html><body><p id="out"></p><script>${script}</script></body></html>`,
        },
      });
      await settle(100);
      return handle;
    };

    const h1 = await mountOnce(
      'localStorage.setItem("keep", "yes"); localStorage.setItem("gone", "1"); localStorage.removeItem("gone"); document.documentElement.style.setProperty("--brand", "#0ea5e9");'
    );
    const docRoot = h1.shadowRoot.querySelector('[data-softn-docroot]') as HTMLElement;
    expect(docRoot.style.getPropertyValue('--brand')).toBe('#0ea5e9');
    h1.dispose();

    const h2 = await mountOnce(
      'document.getElementById("out").textContent = String(localStorage.getItem("keep")) + "|" + String(localStorage.getItem("gone"));'
    );
    expect(h2.shadowRoot.querySelector('#out')?.textContent).toBe('yes|null');
    h2.dispose();
  });

  it('supports Set storeNames in db.transaction(), key-cursor delete(), and canvas.width = 0', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': `<!doctype html><html><body><canvas id="c"></canvas><p id="out"></p><script>
          var c = document.getElementById('c');
          c.width = 0;
          var cw = c.width;
          var req = indexedDB.open('audit_idb', 1);
          req.onupgradeneeded = function () { req.result.createObjectStore('items'); };
          req.onsuccess = function () {
            var db = req.result;
            var tx1 = db.transaction(new Set(['items']), 'readwrite');
            tx1.objectStore('items').put('alpha', 'k1');
            tx1.objectStore('items').put('beta', 'k2');
            tx1.oncomplete = function () {
              var tx2 = db.transaction(new Set(['items']), 'readwrite');
              var curReq = tx2.objectStore('items').openKeyCursor();
              curReq.onsuccess = function () {
                var cur = curReq.result;
                if (cur && cur.key === 'k1') cur.delete();
              };
              tx2.oncomplete = function () {
                var tx3 = db.transaction('items', 'readonly');
                var all = tx3.objectStore('items').getAll();
                all.onsuccess = function () {
                  document.getElementById('out').textContent = cw + ':' + all.result.join(',');
                };
              };
            };
          };
        </script></body></html>`,
      },
    });
    await settle(200);
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('0:beta');
    handle.dispose();
  });

  it('disables frontend softn:sqlite access when manifest.backend is present', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      backendTransport: {
        kind: 'remote',
        ready: Promise.resolve(),
        fetch: async () => ({ status: 200, statusText: 'OK', headers: [], body: new Uint8Array() }),
        dispose: () => undefined,
      },
      source: {
        'manifest.json': JSON.stringify({
          name: 'Isolated Backend',
          engine: 2,
          main: 'index.html',
          backend: { runtime: 'javascript', entry: 'backend/server.js', routes: ['/api/'] },
        }),
        'backend/server.js': 'function handleRequest() { return { status: 200, body: "ok" }; }',
        'index.html': `<!doctype html><html><body><p id="out"></p><script type="module">
          try {
            const sqlite = await import('softn:sqlite');
            const db = await sqlite.open('app.db');
            await db.query('SELECT 1');
            document.getElementById('out').textContent = 'LEAKED';
          } catch (e) {
            document.getElementById('out').textContent = 'BLOCKED';
          }
        </script></body></html>`,
      },
    });
    await settle(150);
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('BLOCKED');
    handle.dispose();
  });

  it('drops Popover/Invoker attributes and unsafe <softn-chart color> while preserving download', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html><html><body></body></html>' });
    const ctx = {
      entryPath: 'index.html',
      archive,
      permissions: { permissions: {} },
      netGranted: false,
    };
    expect(hostAttributeValue('button', 'command', 'show-modal', ctx)).toBeNull();
    expect(hostAttributeValue('button', 'commandfor', 'host-dialog', ctx)).toBeNull();
    expect(hostAttributeValue('button', 'interestfor', 'host-tip', ctx)).toBeNull();
    expect(hostAttributeValue('button', 'interesttarget', 'host-tip', ctx)).toBeNull();
    expect(hostAttributeValue('a', 'download', 'report.txt', ctx)).toBe('report.txt');

    expect(hostAttributeValue('softn-chart', 'color', 'url(https://evil.test/#c)', ctx)).toBeNull();
    expect(hostAttributeValue('softn-chart', 'color', 'red; background:url(https://evil.test)', ctx)).toBeNull();
    expect(hostAttributeValue('softn-chart', 'color', '#3b82f6', ctx)).toBe('#3b82f6');
    expect(hostAttributeValue('softn-chart', 'color', 'rgb(10, 20, 30)', ctx)).toBe('rgb(10, 20, 30)');
    archive.dispose();
  });

  it('enforces frontend VFS isolation on getBlobUrl and blocks navigating to non-HTML or backend files', async () => {
    const archive = await ContainerArchive.open({
      'manifest.json': JSON.stringify({
        name: 'Isolated',
        version: '1.0.0',
        engine: 2,
        main: 'public/index.html',
        frontendRoot: 'public',
        backend: { runtime: 'php', entry: 'server/index.php', routes: ['/api/'], env: { SECRET_KEY: 'top-secret' } },
      }),
      'public/index.html': '<!doctype html><html><body><p>Hello</p></body></html>',
      'public/logo.png': new Uint8Array([137, 80, 78, 71]),
      '.env': 'API_KEY=secret-123',
      'server/index.php': '<?php echo "secret";',
    });

    expect(archive.getBlobUrl('.env')).toBeNull();
    expect(archive.getBlobUrl('server/index.php')).toBeNull();
    expect(archive.resolveFrontendExistingPath('.env')).toBeNull();
    expect(archive.resolveFrontendExistingPath('server/index.php')).toBeNull();
    expect(archive.resolveFrontendExistingPath('logo.png', 'public/index.html')).toBe('public/logo.png');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      backendTransport: {
        kind: 'remote',
        ready: Promise.resolve(),
        fetch: async () => ({ status: 200, statusText: 'OK', headers: [], body: new Uint8Array() }),
        dispose: () => undefined,
      },
      source: {
        'manifest.json': JSON.stringify({ name: 'NavIso', engine: 2, main: 'index.html' }),
        'index.html': '<!doctype html><html><body><p>Home</p></body></html>',
        'app.js': 'console.log(1);',
      },
    });
    await expect(handle.navigate('/manifest.json')).rejects.toThrow();
    await expect(handle.navigate('/app.js')).rejects.toThrow();
    handle.dispose();
    archive.dispose();
  });

  it('namespaces @font-face families per mount so guest fonts cannot hijack host page fonts', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const fakeWoff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      source: {
        'font.woff2': fakeWoff2,
        'index.html': `<!doctype html><html><head><style>
          @font-face { font-family: "Inter"; src: url("./font.woff2") format("woff2"); }
          body { font-family: "Inter", sans-serif; }
        </style></head><body><p>Hi</p></body></html>`,
      },
    });
    await settle(100);

    const headStyle = document.head.querySelector(`style[data-softn-fonts="${handle.appId}"]`);
    expect(headStyle?.textContent).toBeTruthy();
    // Must be namespaced with softn-f-<n>-Inter, never bare font-family: "Inter"
    expect(headStyle?.textContent).toMatch(/font-family:\s*"softn-f-\d+-Inter"/);
    expect(headStyle?.textContent).not.toMatch(/font-family:\s*"Inter"/);

    const shadowCss = [...handle.shadowRoot.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    expect(shadowCss).toMatch(/font-family:\s*"softn-f-\d+-Inter",\s*sans-serif/);

    handle.dispose();
  });

  it('sanitizes SVG <a xlink:href> and forces rel="noopener noreferrer"', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      source: {
        'index.html': `<!doctype html><html><body>
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
            <a id="good" xlink:href="https://example.test/docs"><text>Docs</text></a>
            <a id="evil" xlink:href="javascript:alert(1)"><text>Bad</text></a>
          </svg>
        </body></html>`,
      },
    });
    await settle(100);

    const good = handle.shadowRoot.querySelector('#good');
    const evil = handle.shadowRoot.querySelector('#evil');
    expect(good?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(good?.getAttribute('target')).toBe('_blank');
    expect(evil?.getAttribute('href')).toBeNull();
    expect(evil?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
    handle.dispose();
  });

  it('enforces storage quota on guest sessionStorage writes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: true,
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      limits: { storageQuotaBytes: 1024 },
      source: {
        'index.html': `<!doctype html><html><body><p id="out"></p><script>
          var status = 'ok';
          try {
            sessionStorage.setItem('big', 'x'.repeat(2000));
            status = 'leaked';
          } catch (e) {
            status = 'quota';
          }
          document.getElementById('out').textContent = status;
        </script></body></html>`,
      },
    });
    await settle(150);
    expect(handle.shadowRoot.querySelector('#out')?.textContent).toBe('quota');
    handle.dispose();
  });
});

describe('SoftN v2 Round-2 Security Audit Regressions', () => {
  it('blocks @font-face CSS injection via bracket desync, escaped quotes, CSS-escaped at-rule, and non-font descriptors', () => {
    // 1. Bracket desync: @media [ { @font-face { ... } } ] {}
    const bracketDesync = '@media [ { @font-face { font-family: "Hijack"; src: url("data:font/woff2;base64,AA=="); } } ] {}';
    expect(extractFontFaces(bracketDesync, 'softn-f-1-')).toBe('');

    // 2. Escaped quote + brace breakout inside @font-face
    const quoteBreakout = '@font-face { font-family: \\" { ; } body { background: red } "; src: url("data:font/woff2;base64,AA=="); }';
    const out2 = extractFontFaces(quoteBreakout, 'softn-f-1-');
    expect(out2).not.toContain('body');
    expect(out2).not.toContain('background');
    expect(out2).toBe('');

    // 3. CSS-escaped @\66 ont-face must still be detected and namespaced
    const escapedAt = '@\\66 ont-face { font-family: "Inter"; src: local("Arial"); color: red; }';
    const declared = new Set<string>();
    const nsCss = namespaceContainerFonts(escapedAt, 'softn-f-9-', declared);
    expect(declared.has('inter')).toBe(true);
    expect(nsCss).toContain('softn-f-9-Inter');
    expect(nsCss).not.toContain('color');

    const extracted = extractFontFaces(escapedAt, 'softn-f-9-');
    expect(extracted).toContain('softn-f-9-Inter');
    expect(extracted).not.toContain('color');
  });

  it('allowlists only known hosted vendor modules for external /runtime/vendor fetches', async () => {
    expect(isAllowedExternalVendorModule('three')).toBe(true);
    expect(isAllowedExternalVendorModule('three/addons/controls/OrbitControls')).toBe(true);
    expect(isAllowedExternalVendorModule('preact/hooks')).toBe(true);
    expect(isAllowedExternalVendorModule('arbitrary-tracker')).toBe(false);
    expect(isAllowedExternalVendorModule('../api/me')).toBe(false);

    const fetchSpy = vi.fn(async () => new Response('export default 1;', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const handle = await mountSoftNContainer(host, {
        isolation: 'inline',
        persistStorage: false,
        permissionMode: 'deny',
        engineWasm: { lite: LITE_WASM },
        source: {
          'index.html': `<!doctype html><html><body><p id="res"></p><script type="module">
            try {
              await import('unlisted-egress-probe');
              document.getElementById('res').textContent = 'loaded';
            } catch (e) {
              document.getElementById('res').textContent = 'blocked';
            }
          </script></body></html>`,
        },
      });
      await settle(150);
      expect(handle.shadowRoot.querySelector('#res')?.textContent).toBe('blocked');
      expect(fetchSpy).not.toHaveBeenCalled();
      handle.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('blocks ReDoS patterns and prevents Apache variable double-expansion in .htaccess', () => {
    const ht = parseHtaccess([
      'RewriteEngine On',
      'RewriteRule ^(a|a)+$ /bad.php [L]',
      'RewriteRule ^([a-z]{1,10})+$ /bad2.php [L]',
      'RewriteRule ^go/(.+)$ /dest?q=$1 [R=302,L]',
    ].join('\n'));
    // Unsafe ReDoS rules are rejected during compilation, leaving only the safe redirect rule
    expect(ht.rules.length).toBe(1);

    const res = evaluateHtaccessChain(
      new Map([['', ht]]),
      {
        pathname: '/go/%{HTTP:Cookie}',
        query: '',
        method: 'GET',
        host: 'app.softn.local',
        headers: { cookie: 'session=SECRET123' },
        https: true,
      },
      { isFile: () => false, isDir: () => false }
    );
    expect(res.action).toBe('redirect');
    if (res.action === 'redirect') {
      expect(res.location).not.toContain('SECRET123');
      expect(res.location).toContain('%{HTTP:Cookie}');
    }
  });

  it('caps VirtualCookieJar entry count and byte size and restricts isDeclaredElementProperty to setters', () => {
    const jar = new VirtualCookieJar();
    for (let i = 0; i < 400; i++) {
      jar.setCookieHeader(`c${i}=${'x'.repeat(20)}; Path=/`);
    }
    const serialized = JSON.parse(jar.serialize()) as unknown[];
    expect(serialized.length).toBeLessThanOrEqual(256);

    class FakeEl {
      private _rows: unknown[] = [];
      get rows() { return this._rows; }
      set rows(v: unknown[]) { this._rows = v; }
      render() { return 'ok'; }
    }
    const inst = new FakeEl() as unknown as Element;
    expect(isDeclaredElementProperty(inst, 'rows')).toBe(true);
    expect(isDeclaredElementProperty(inst, 'render')).toBe(false);
  });
});
