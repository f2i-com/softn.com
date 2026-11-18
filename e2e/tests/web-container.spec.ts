/**
 * A web container in the runtime: a plain HTML, CSS and JavaScript app, opened as a file.
 *
 * @softn/container runs such an app's script in a Worker, on the smallest ZIPP engine that
 * can run it, and draws its page into a closed shadow root. Its unit suites run it in jsdom,
 * where there is no Worker and the engine is handed over as a file, so what only a browser
 * and the built deployment show is here:
 *
 *   - the Worker starts from the deployment's folder, each tier finds its engine and the
 *     bindings that go with that engine, and a click reaches the app and comes back as a
 *     change to the page;
 *   - the folder is the site's one shared copy (/shared/container-runtime/<digest>/), named
 *     by the digest of what is in it, and no app keeps one of its own;
 *   - it is asked for nothing the site already has: an app that needs `Intl`, and a Python
 *     app, run on the engine the runtime carries for its own apps, under that engine's
 *     bindings, and no second copy of it is fetched under another name.
 *
 * The bundles are built here (helpers/bundle.ts), so nothing about the deployment's demos
 * is assumed.
 */
import { expect, test, type Page, type Request } from '@playwright/test';
import { containerBundle } from '../helpers/bundle';
import { watchConsole } from '../helpers/console';
import { cachedWasm, fullEngine, liteEngine, requestedWasm } from '../helpers/engines';
import { test as offlineTest } from '../helpers/offlineSite';
import { centreOf, clickIn, keepShadowRoots, openBundle, seeIn, shown, textIn } from '../helpers/container';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const SHARED_FOLDER = /^\/shared\/container-runtime\/[0-9a-f]{12}\//;

const page_ = (title: string, body: string, script: string, type = 'module') => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>body { font-family: system-ui, sans-serif; padding: 24px; } button { padding: 8px 14px; }</style>
</head>
<body>
${body}
<script type="${type}">
${script}
</script>
</body>
</html>`;

// The page says "Starting…" until its script has run, so "Count: 0" means the listener is on.
const COUNTER = page_(
  'Plain Counter',
  '<h1>Plain Counter</h1>\n<p id="out">Starting…</p>\n<button id="add" type="button">Add one</button>',
  `let count = 0;
const out = document.getElementById('out');
document.getElementById('add').addEventListener('click', () => {
  count += 1;
  out.textContent = 'Count: ' + count;
});
out.textContent = 'Count: 0';`
);

const PRICES = page_(
  'Price List',
  '<h1>Price List</h1>\n<p id="out">…</p>',
  `document.getElementById('out').textContent = 'Total: ' + new Intl.NumberFormat('en-US').format(1234567.891);`
);

const TYPED_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Typed Totals</title><script type="module" src="./app.ts"></script></head>
<body><h1>Typed Totals</h1><p id="out">…</p></body>
</html>`;

const TYPED_TS = `interface Line { label: string; pence: number }
const lines: Line[] = [{ label: 'tea', pence: 1900 }, { label: 'cake', pence: 2300 }];
function total(all: readonly Line[]): number {
  return all.reduce((sum: number, line: Line) => sum + line.pence, 0);
}
document.getElementById('out')!.textContent = 'Total: ' + total(lines) / 100;
`;

const PYTHON = page_('Python Hello', '<h1>Python Hello</h1>\n<p id="out">The page is plain HTML.</p>', 'print("python says", 6 * 7)', 'text/python');

interface Fetched {
  path: string;
  status: number;
}

/** Every request the page and its workers make for the container's folder or for an engine, with its answer. */
function watchRuntimeRequests(page: Page): Fetched[] {
  const fetched: Fetched[] = [];
  const wanted = (request: Request) => /container-runtime|\.wasm(?:$|\?)/.test(new URL(request.url()).pathname);
  page.on('requestfinished', (request) => {
    if (!wanted(request)) return;
    void request.response().then((response) => fetched.push({ path: new URL(request.url()).pathname, status: response?.status() ?? 0 }));
  });
  page.on('requestfailed', (request) => {
    if (wanted(request)) fetched.push({ path: new URL(request.url()).pathname, status: 0 });
  });
  return fetched;
}

const ofFolder = (fetched: Fetched[]) => fetched.filter((entry) => entry.path.includes('container-runtime'));
const names = (fetched: Fetched[]) => fetched.map((entry) => entry.path.replace(SHARED_FOLDER, '')).sort();

test('a plain JavaScript app runs in its Worker on the lite engine, from the site’s one shared folder', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const fetched = watchRuntimeRequests(page);
  const jsAssets: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/shared/assets/') && pathname.endsWith('.js')) {
      jsAssets.push(pathname);
    }
  });
  try {
    await openBundle(page, 'PlainCounter.softn', containerBundle({ 'index.html': COUNTER }));
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Count: 0');

    // A real click, in the page: the Worker runs the app's listener and sends back the change.
    const add = await centreOf(page, '#add');
    await page.mouse.click(add.x, add.y);
    await expect.poll(() => shown(page)).toContain('Count: 1');
    await page.mouse.click(add.x, add.y);
    await expect.poll(() => shown(page)).toContain('Count: 2');

    // The Worker, the lite engine and its bindings, each from the shared folder and each found.
    const folder = ofFolder(fetched);
    expect(folder.every((entry) => SHARED_FOLDER.test(entry.path)), JSON.stringify(folder)).toBe(true);
    expect(folder.filter((entry) => entry.status !== 200)).toEqual([]);
    expect([...new Set(names(folder))]).toEqual(['container-worker.js', 'engines/zipp-javascript-lite.glue.js', 'engines/zipp-javascript-lite.wasm']);
    // Container-first guarantee: opening `/web/` and running a JS Web Container never loads the `.ui` surface or component chunks.
    expect(
      jsAssets.filter((p) => /\/(UiAppSurface|UiApplicationSurface|lazy|scene3d|charts|editors|smart|media|animation|pickers|games)-/.test(p)),
      JSON.stringify(jsAssets),
    ).toEqual([]);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('plain-counter');
  }
});

test('opening a web app folder runs nested modules and keeps its saved data when reopened', async ({ page }, testInfo) => {
  const folder = testInfo.outputPath('FolderCounter');
  const assets = path.join(folder, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), `<!doctype html>
    <title>Folder Counter</title>
    <button id="count">Starting…</button>
    <script type="module" src="./assets/main.js"></script>`);
  fs.writeFileSync(path.join(assets, 'main.js'), `
    import { step } from './step.js';
    const button = document.getElementById('count');
    let count = Number(localStorage.getItem('count') || 0);
    button.textContent = String(count);
    button.addEventListener('click', () => {
      count += step;
      localStorage.setItem('count', String(count));
      button.textContent = String(count);
    });`);
  const stepFile = path.join(assets, 'step.js');
  fs.writeFileSync(stepFile, 'export const step = 2;');

  await keepShadowRoots(page);
  const openFolder = async () => {
    await page.goto('/web/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await (await chooser).setFiles(folder);
  };

  await openFolder();
  await expect.poll(() => textIn(page, '#count'), { timeout: 60_000 }).toBe('0');
  await clickIn(page, '#count');
  await expect.poll(() => textIn(page, '#count')).toBe('2');

  // A fresh page and a changed file timestamp still identify the same app by its contents.
  const stamp = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(stepFile, stamp, stamp);
  await openFolder();
  await expect.poll(() => textIn(page, '#count'), { timeout: 60_000 }).toBe('2');
});

test('an app that formats with Intl runs on the engine the runtime already has, under that engine’s bindings', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const fetched = watchRuntimeRequests(page);
  try {
    await openBundle(page, 'PriceList.softn', containerBundle({ 'index.html': PRICES }));
    // The lite engine has no Intl; this is the full engine's answer.
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Total: 1,234,567.891');

    const folder = ofFolder(fetched);
    expect(folder.filter((entry) => entry.status !== 200)).toEqual([]);
    // No engine from the folder: the site's own, which it keeps once under /shared/assets/.
    expect([...new Set(names(folder))]).toEqual(['container-worker.js', 'engines/zipp-python-base.glue.js']);
    const engines = fetched.filter((entry) => /\.wasm$/.test(entry.path)).map((entry) => entry.path);
    expect(engines.every((path) => /^\/shared\/assets\/zipp_wasm_bg-[\w-]+\.wasm$/.test(path)), JSON.stringify(engines)).toBe(true);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('price-list');
  }
});

test('a TypeScript app runs as written, on the TypeScript engine', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const fetched = watchRuntimeRequests(page);
  try {
    await openBundle(page, 'TypedTotals.softn', containerBundle({ 'index.html': TYPED_HTML, 'app.ts': TYPED_TS }));
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Total: 42');

    const folder = ofFolder(fetched);
    expect(folder.filter((entry) => entry.status !== 200)).toEqual([]);
    expect([...new Set(names(folder))]).toEqual(['container-worker.js', 'engines/zipp-typescript.glue.js', 'engines/zipp-typescript.wasm']);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('typed-totals');
  }
});

test('a Python script runs on the runtime’s own engine, and what it prints reaches the console', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const fetched = watchRuntimeRequests(page);
  try {
    await openBundle(page, 'PythonHello.softn', containerBundle({ 'index.html': PYTHON }));
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('The page is plain HTML.');
    await expect.poll(() => log.all.some((line) => line.includes('python says 42')), { timeout: 60_000 }).toBe(true);

    const folder = ofFolder(fetched);
    expect(folder.filter((entry) => entry.status !== 200)).toEqual([]);
    expect([...new Set(names(folder))]).toEqual(['container-worker.js', 'engines/zipp-python-base.glue.js']);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('python-hello');
  }
});

const ORBIT_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Orbit</title><script type="module" src="./scene.js"></script></head>
<body><p id="state">Starting…</p><canvas id="gl" width="320" height="200"></canvas></body>
</html>`;

const ORBIT_JS = `import * as THREE from 'three';
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(320, 200);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 320 / 200, 0.1, 100);
camera.position.set(0, 1, 3);
scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3b82f6 })));
scene.add(new THREE.AmbientLight(0xffffff, 1));
renderer.render(scene, camera);
document.getElementById('state').textContent = 'Scene drawn';
`;

test('a 3D scene is drawn by the runtime’s own Three.js: the folder ships no second copy', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const scripts: Fetched[] = [];
  page.on('requestfinished', (request) => {
    const path = new URL(request.url()).pathname;
    if (/three/i.test(path)) void request.response().then((response) => scripts.push({ path, status: response?.status() ?? 0 }));
  });
  try {
    await openBundle(page, 'Orbit.softn', containerBundle({ 'index.html': ORBIT_HTML, 'scene.js': ORBIT_JS }));
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Scene drawn');
    // Three.js came from the runtime's own chunk, and nothing asked the folder for one.
    await expect
      .poll(() => scripts.some((entry) => /^\/shared\/assets\/vendor-three-[\w-]+\.js$/.test(entry.path) && entry.status === 200), { timeout: 30_000 })
      .toBe(true);
    // The page's side of the scene, where this browser can draw one at all (a machine with
    // no graphics may not): the canvas is a WebGL one once the renderer has it, at the size
    // the app asked for.
    const canDraw = await page.evaluate(() => {
      const probe = document.createElement('canvas');
      return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
    });
    if (canDraw) {
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              for (const root of (window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? []) {
                const canvas = root.querySelector('canvas');
                if (canvas) return { webgl: canvas.getContext('2d') === null, width: canvas.width > 0, height: canvas.height > 0 };
              }
              return null;
            }),
          { timeout: 30_000 }
        )
        .toEqual({ webgl: true, width: true, height: true });
    }
    expect(scripts.filter((entry) => /\/vendor\/three\.js$/.test(entry.path)), JSON.stringify(scripts)).toEqual([]);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('orbit');
  }
});

// A second page that formats a number, so the app starts on two engines: the lite one, and the
// runtime's own.
const TWO_PAGES_HOME = page_(
  'Offline Shop',
  '<h1>Offline Shop</h1>\n<p id="out">Starting…</p>\n<button id="add" type="button">Add one</button>\n<a id="prices" href="./prices.html">Prices</a>',
  `let count = 0;
const out = document.getElementById('out');
document.getElementById('add').addEventListener('click', () => {
  count += 1;
  out.textContent = 'Basket: ' + count;
});
out.textContent = 'Basket: 0';`
);
const TWO_PAGES_PRICES = page_(
  'Prices',
  '<h1>Prices</h1>\n<p id="out">…</p>',
  `document.getElementById('out').textContent = 'Total: ' + new Intl.NumberFormat('en-US').format(1234567.891);`
);

offlineTest('a web container opened once online is installed, and opens from Home and runs with the network gone', async ({ page, context, offlineSite }, testInfo) => {
  test.setTimeout(240_000);
  const log = watchConsole(page, testInfo);
  const requests = requestedWasm(context);
  await keepShadowRoots(page);
  const NAME = 'Offline Shop';
  try {
    await page.goto(offlineSite.origin + '/web/');
    await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
    // The install waits for the service worker to control the page; so does this.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 60_000 });
    // A new Home installation has no apps. Its service worker must not fetch the full engine.
    expect((await cachedWasm(page)).filter((path) => fullEngine.test(path))).toEqual([]);
    expect([...requests].filter((path) => fullEngine.test(path))).toEqual([]);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open file', exact: true }).click();
    await (await chooser).setFiles({
      name: 'OfflineShop.softn',
      mimeType: 'application/octet-stream',
      buffer: containerBundle({ 'index.html': TWO_PAGES_HOME, 'prices.html': TWO_PAGES_PRICES }),
    });
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Basket: 0');

    // Home says when the install has everything: no card of a container ever did.
    await page.locator('.softn-frame-home').first().click();
    const card = page.getByRole('button', { name: `Open ${NAME}`, exact: true });
    await expect(card.locator('.softn-launcher-offline')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
    await expect(card).toHaveAccessibleDescription(/Lite JavaScript \+ Full engine/);
    const installed = await cachedWasm(page);
    expect(installed.filter((path) => fullEngine.test(path))).toHaveLength(1);
    expect(installed.filter((path) => liteEngine.test(path))).toHaveLength(1);

    offlineSite.disconnect();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: `Open ${NAME}`, exact: true }).click();
    // The Worker, the lite engine and its bindings, all from what the service worker kept.
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Basket: 0');
    const add = await centreOf(page, '#add');
    await page.mouse.click(add.x, add.y);
    await expect.poll(() => shown(page)).toContain('Basket: 1');
    // The other page starts on the runtime's own engine, whose bindings were installed too
    // though no page had asked for them yet.
    const prices = await centreOf(page, '#prices');
    await page.mouse.click(prices.x, prices.y);
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Total: 1,234,567.891');
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('offline-container');
  }
});

// Each of these ran script in the page, or reached another origin, in v0.0.43 (the unit suite
// has the whole list, in jsdom; these are the ones only a browser shows as they are).
const HOSTILE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Hostile</title>
<style>
  :host { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }
  .a { background: u\\72l(https://softn-e2e.invalid/escaped.png); }
  .b { background-image: image-set("https://softn-e2e.invalid/set.png" 1x); }
</style></head>
<body>
<svg width="10" height="10"><svg:script>window.__softnPwned = 'static svg:script'</svg:script></svg>
<img srcset="https://softn-e2e.invalid/srcset.png 1x" alt="">
<a id="out" href="https://softn-e2e.invalid/landed" target="_top" ping="https://softn-e2e.invalid/ping">leave</a>
<p id="done">Starting…</p>
<script>
  var box = document.createElement('div');
  document.body.appendChild(box);
  var id = 900001;
  __softnPushExtraOp(['e', id, 'svg:script', {}, 'svg']);
  __softnPushExtraOp(['x', id + 1, "window.__softnPwned = 'dynamic svg:script'"]);
  __softnPushExtraOp(['c', id, [id + 1]]);
  __softnPushExtraOp(['c', box.__softnNode, [id]]);
  var el = document.createElement('softn-anything');
  document.body.appendChild(el);
  __softnPushExtraOp(['p', el.__softnNode, 'innerHTML', '<img src="x" onerror="window.__softnPwned = \\'innerHTML\\'">']);
  var sheet = document.createElement('style');
  sheet.textContent = '@import url("https://softn-e2e.invalid/import.css"); p { background: url(https://softn-e2e.invalid/dynamic.png); }';
  document.body.appendChild(sheet);
  document.getElementById('done').textContent = 'Hostile ran';
</script>
</body>
</html>`;

test('an app cannot run script in the runtime’s page, reach an origin it was not granted, or leave its box', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const outside: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'softn-e2e.invalid') outside.push(request.url());
  });
  try {
    await openBundle(page, 'Hostile.softn', containerBundle({ 'index.html': HOSTILE }));
    await expect.poll(() => shown(page), { timeout: 60_000 }).toContain('Hostile ran');
    // Long enough for an image, a stylesheet or a script that was let through to be asked for.
    await page.waitForTimeout(1500);

    expect(await page.evaluate(() => (window as unknown as { __softnPwned?: string }).__softnPwned ?? null)).toBeNull();
    expect(outside).toEqual([]);

    // The link out is the container's to open: a new tab with no handle on this page, which stays.
    const before = page.url();
    const link = await centreOf(page, '#out');
    const popup = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await page.mouse.click(link.x, link.y);
    const opened = await popup;
    expect(page.url()).toBe(before);
    expect(opened, 'the link opened in a tab of its own').not.toBeNull();
    await opened?.close();
    // ping, which posts wherever it names when a link is clicked, was never set.
    expect(outside.filter((url) => url.includes('/ping'))).toEqual([]);

    // The runtime's own bar is still on top of the app and still answers.
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('hostile');
  }
});

// An element of the app's own with a shadow tree. The unit suite has the tree and the rules
// (test/shadow-dom.test.ts); what only a browser does is here: it fills the slots with the
// element's own children, applies the tree's stylesheet to the element (`:host`), and would
// send a form or follow a link inside the tree by itself if the container did not hear of it.
const CARD = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Card</title></head>
<body>
<user-card id="card"><span slot="title" id="given">Ada</span><em id="rest">and the rest</em></user-card>
<p id="seen">none</p>
<script>
  class UserCard extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host { display: block; letter-spacing: 3px } .frame { color: rgb(4, 5, 6) }</style>' +
        '<div class="frame"><h2 id="heading"><slot name="title">nobody</slot></h2><slot></slot> <button id="add" type="button">Add one</button> <b id="count">0</b> ' +
        '<a id="next" href="second.html">next</a><form id="form" action="/nowhere"><input id="q" name="q"><button id="send">send</button></form></div>';
      let count = 0;
      root.getElementById('add').addEventListener('click', () => { count += 1; root.getElementById('count').textContent = String(count); });
      root.getElementById('form').addEventListener('submit', (event) => {
        event.preventDefault();
        document.getElementById('seen').textContent = 'sent:' + new FormData(event.target).get('q');
      });
    }
  }
  customElements.define('user-card', UserCard);
  document.getElementById('seen').textContent = 'ready';
</script>
</body>
</html>`;

test('an element with a shadow tree: its slots are filled, its stylesheet is its own, and a form or a link inside it is the app’s', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  try {
    await openBundle(page, 'Card.softn', containerBundle({ 'index.html': CARD, 'second.html': page_('Second', '<p id="where">second page</p>', '') }));
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
    const address = page.url();

    // The tree is drawn in the element's place, and the element's own children where its slots are.
    await expect.poll(() => textIn(page, '#count')).toBe('0');
    const heading = (await seeIn(page, '#heading'))!;
    const given = (await seeIn(page, '#given'))!;
    expect(given.width, 'the child given to the title slot is drawn').toBeGreaterThan(0);
    expect(given.top, 'inside the heading the slot is in').toBeGreaterThanOrEqual(heading.top - 1);
    expect(given.top + given.height).toBeLessThanOrEqual(heading.top + heading.height + 1);
    expect((await seeIn(page, '#rest'))!.width, 'the other child is drawn in the unnamed slot').toBeGreaterThan(0);
    // :host is the app's own element in the tree's stylesheet, and the stylesheet applies inside.
    expect((await seeIn(page, '#card'))?.letterSpacing).toBe('3px');
    expect((await seeIn(page, '.frame'))?.color).toBe('rgb(4, 5, 6)');

    // A real click inside the tree.
    await clickIn(page, '#add');
    await expect.poll(() => textIn(page, '#count')).toBe('1');

    // Enter in a field of a form inside the tree: the app's listener hears it, and the
    // browser sends nothing (a submit does not leave the tree it happened in).
    await clickIn(page, '#q');
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');
    await expect.poll(() => textIn(page, '#seen')).toBe('sent:hello');
    expect(page.url()).toBe(address);

    // A link inside the tree is the container's to follow: a page of the app's, shown in the app.
    await clickIn(page, '#next');
    await expect.poll(() => textIn(page, '#where')).toBe('second page');
    expect(page.url()).toBe(address);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('shadow-tree');
  }
});

// Saving a file, and reading one the person picks. Each crosses the app's box, so each is
// the person's to allow: the page asks before a file is saved, in a bar of its own that
// names the app and the file, and a picked file is read only for an app that was allowed files.
const FILES = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Files</title>
<style>
  /* Words of the app's own, drawn over the bar that asks the person: what an app would do to have "Save" pressed for a file it did not name. */
  [data-softn-container-save]::after, [data-softn-frame]::before {
    content: "Notes wants to save notes.txt" !important; position: absolute !important; inset: 0 !important;
    background: #0f172a !important; color: #fff !important; z-index: 2147483647 !important; pointer-events: none !important;
  }
</style>
</head>
<body>
<button id="export" type="button">Export</button>
<input id="pick" type="file">
<p id="picked">starting</p>
<script>
  document.getElementById('export').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['a,b\\n1,2\\n'], { type: 'text/csv' }));
    link.download = 'table.csv';
    link.click();
  });
  const pick = document.getElementById('pick');
  pick.addEventListener('change', async () => {
    const file = pick.files[0];
    document.getElementById('picked').textContent = file ? file.name + ':' + file.size + ':' + (await file.text()) : 'no file was handed over';
  });
  // Said by the script: the runtime's "Starting…" is over the app until its script has run.
  document.getElementById('picked').textContent = 'nothing picked';
</script>
</body>
</html>`;

test('a file is saved only at the person’s word, in the page’s own bar, and a picked file is read only by an app allowed files', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const pickFile = async () => {
    const chooser = page.waitForEvent('filechooser');
    await clickIn(page, '#pick');
    await (await chooser).setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  };
  try {
    // An app that asked for nothing: its file field hands it nothing.
    await openBundle(page, 'Files.softn', containerBundle({ 'index.html': FILES }));
    await expect.poll(() => textIn(page, '#picked'), { timeout: 60_000 }).toBe('nothing picked');
    await pickFile();
    await expect.poll(() => textIn(page, '#picked')).toBe('no file was handed over');

    // Saving: the bar names the app and the file; "Not now" saves nothing.
    await clickIn(page, '#export');
    await expect.poll(() => textIn(page, '[data-softn-save-bar]')).toContain('wants to save a file to this device: “table.csv”');
    let downloads = 0;
    page.on('download', () => downloads++);
    // A click that lands on "Save" as the bar appears (it was on its way to the app) is not a yes.
    await clickIn(page, '[data-softn-save-allow]');
    expect(await seeIn(page, '[data-softn-save-bar]')).not.toBeNull();
    await clickIn(page, '[data-softn-save-deny]');
    await expect.poll(() => seeIn(page, '[data-softn-save-bar]')).toBeNull();
    expect(downloads).toBe(0);
    // And "Save" saves it, under the name given, with the bytes the app made.
    await page.waitForTimeout(600);
    await clickIn(page, '#export');
    await expect.poll(async () => (await seeIn(page, '[data-softn-save-allow]')) !== null).toBe(true);
    // The app's stylesheet draws nothing on the bar or the frame it is in: they are in
    // another root than the app's page, and a stylesheet matches only what is in its own.
    const drawn = await page.evaluate(() => {
      for (const root of (window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? []) {
        const holder = root.querySelector('[data-softn-container-save]');
        const frame = root.querySelector('[data-softn-frame]');
        if (holder && frame) return [getComputedStyle(holder, '::after').content, getComputedStyle(frame, '::before').content];
      }
      return null;
    });
    expect(drawn).toEqual(['none', 'none']);
    await page.waitForTimeout(500);
    const saved = page.waitForEvent('download');
    await clickIn(page, '[data-softn-save-allow]');
    const download = await saved;
    expect(download.suggestedFilename()).toBe('table.csv');
    expect(fs.readFileSync(await download.path(), 'utf8')).toBe('a,b\n1,2\n');

    // The same app, declaring files: once the person allows it, what they pick is read.
    await openBundle(page, 'FilesAllowed.softn', containerBundle({ 'index.html': FILES.replace('<title>Files</title>', '<title>Files Allowed</title>'), 'permission.json': JSON.stringify({ permissions: { files: { enabled: true } } }) }));
    await expect.poll(() => textIn(page, '#picked'), { timeout: 60_000 }).toBe('nothing picked');
    await page.locator('[data-softn-consent]').getByRole('button', { name: 'Allow', exact: true }).click();
    await pickFile();
    await expect.poll(() => textIn(page, '#picked')).toBe('note.txt:5:hello');
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('files');
  }
});

// An answer from the network, read as it arrives. The unit suite has the rules
// (test/web-apis.test.ts) against a network it writes by hand; here the Worker reads a real
// server through the browser's own fetch, a piece at a time, and hands each piece to the app
// before the next is written.
const STREAMING = (port: number) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Streaming</title></head>
<body>
<button id="go" type="button">Ask</button> <button id="listen" type="button">Listen</button>
<p id="seen">starting</p>
<p id="feed">not listening</p>
<script>
  const base = 'http://127.0.0.1:${port}';
  const seen = [];
  const say = (what) => { seen.push(what); document.getElementById('seen').textContent = seen.join(' '); };
  document.getElementById('go').addEventListener('click', async () => {
    try {
      const response = await fetch(base + '/words');
      say('head:' + response.status);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        say('[' + step.value + ']');
      }
      say('end');
    } catch (error) {
      say('failed:' + error.message);
    }
  });
  document.getElementById('listen').addEventListener('click', () => {
    const told = [];
    const tell = (what) => { told.push(what); document.getElementById('feed').textContent = told.join(' '); };
    const feed = new EventSource(base + '/feed');
    feed.onopen = () => tell('open');
    feed.onmessage = (event) => tell('message:' + event.data + ':' + event.lastEventId);
    feed.onerror = () => tell('error');
  });
  document.getElementById('seen').textContent = 'ready';
</script>
</body>
</html>`;

test('an answer from the network is the app’s as it arrives, and a feed is read a message at a time and asked for again', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  // A server that writes when the test says so.
  const held: Record<string, http.ServerResponse[]> = { '/words': [], '/feed': [] };
  const asked: Array<{ method: string; path: string; place: string | undefined; cookie: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    asked.push({ method: request.method ?? '', path, place: request.headers['last-event-id'] as string | undefined, cookie: request.headers.cookie });
    response.setHeader('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers'] ?? '');
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { 'content-type': path === '/feed' ? 'text/event-stream' : 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.flushHeaders();
    (held[path] ??= []).push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await openBundle(
      page,
      'Streaming.softn',
      containerBundle({
        'index.html': STREAMING(port),
        'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allow_http: true, allowed_hosts: ['127.0.0.1'] } } }),
      })
    );
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
    await page.locator('[data-softn-consent]').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
    const address = page.url();

    // The head, then each piece as the server writes it: the app has one before the next exists.
    await clickIn(page, '#go');
    await expect.poll(() => held['/words'].length).toBe(1);
    await expect.poll(() => textIn(page, '#seen')).toBe('head:200');
    held['/words'][0].write('one');
    await expect.poll(() => textIn(page, '#seen')).toBe('head:200 [one]');
    held['/words'][0].write('two');
    await expect.poll(() => textIn(page, '#seen')).toBe('head:200 [one] [two]');
    held['/words'][0].end();
    await expect.poll(() => textIn(page, '#seen')).toBe('head:200 [one] [two] end');

    // A feed: a message at a time, and asked for again from where it left off when it ends.
    await clickIn(page, '#listen');
    await expect.poll(() => held['/feed'].length).toBe(1);
    await expect.poll(() => textIn(page, '#feed')).toBe('open');
    held['/feed'][0].write('retry: 100\nid: 5\ndata: first\n\n');
    await expect.poll(() => textIn(page, '#feed')).toBe('open message:first:5');
    held['/feed'][0].end();
    await expect.poll(() => held['/feed'].length).toBe(2);
    await expect.poll(() => textIn(page, '#feed')).toBe('open message:first:5 error open');
    held['/feed'][1].write('data: second\n\n');
    await expect.poll(() => textIn(page, '#feed')).toBe('open message:first:5 error open message:second:5');

    // The first asking of each needed no question put to the server first; the second
    // asking of the feed named its place, and nothing of the page's went with any of them.
    const feeds = asked.filter((one) => one.path === '/feed' && one.method === 'GET');
    expect(feeds.map((one) => one.place)).toEqual([undefined, '5']);
    expect(asked.slice(0, 2).map((one) => one.method + ' ' + one.path)).toEqual(['GET /words', 'GET /feed']);
    expect(asked.every((one) => one.cookie === undefined)).toBe(true);
    expect(page.url()).toBe(address);
    expect(log.uncaught).toEqual([]);
  } finally {
    for (const open of Object.values(held).flat()) open.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await log.attach('streaming');
  }
});

test('the shared folder is served as files that may be kept: found, typed, and missing ones are 404s', async ({ request }) => {
  // The folder's address, from the runtime's own script: whatever digest this build has.
  const html = await (await request.get('/web/')).text();
  // The runtime's scripts are in the site's one folder of built files, with every other app's.
  const scripts = [...html.matchAll(/(?:src|href)="(\/shared\/assets\/[^"]+\.js)"/g)].map((match) => match[1]);
  expect(scripts.length, 'the runtime page names its scripts in /shared/assets/').toBeGreaterThan(0);
  expect(html).not.toMatch(/\/web\/assets\//);
  let folder = '';
  for (const src of scripts) {
    const found = /\/shared\/container-runtime\/[0-9a-f]{12}\//.exec(await (await request.get(src)).text());
    if (found) {
      folder = found[0];
      break;
    }
  }
  // The entry reaches it through a chunk; any of the runtime's scripts may be the one that names it.
  if (!folder) {
    const listing = await (await request.get('/web/sw.js')).text();
    for (const chunk of [...new Set([...listing.matchAll(/\/shared\/assets\/[\w.-]+\.js/g)].map((match) => match[0]))]) {
      const found = /\/shared\/container-runtime\/[0-9a-f]{12}\//.exec(await (await request.get(chunk)).text());
      if (found) {
        folder = found[0];
        break;
      }
    }
  }
  expect(folder, 'a script of the runtime names the shared folder').toMatch(SHARED_FOLDER);

  for (const [file, type] of [
    ['container-worker.js', /javascript/],
    ['engines/zipp-javascript-lite.wasm', /^application\/wasm/],
    ['engines/zipp-typescript.wasm', /^application\/wasm/],
    ['engines/zipp-python-base.glue.js', /javascript/],
  ] as const) {
    const response = await request.get(folder + file);
    expect(response.status(), file).toBe(200);
    expect(response.headers()['content-type'] ?? '', file).toMatch(type);
  }
  // What the site already has is not here under another name, and a file that is not there is not a page.
  for (const file of ['engines/zipp-python-base.wasm', 'engines/zipp-javascript.wasm', 'engines/zipp-torch.wasm', 'softn.js']) {
    expect((await request.get(folder + file)).status(), file).toBe(404);
  }
  // No app keeps a folder of its own, and a file that is not there is a 404, not the app's page.
  for (const app of ['web', 'studio', 'builder', 'play']) {
    for (const file of ['container-runtime/container-worker.js', 'core-runtime/runtime/script-worker.js', 'index-00000000.js']) {
      expect((await request.get(`/${app}/assets/${file}`)).status(), `${app} ${file}`).toBe(404);
    }
  }
  // Core's workers and the torch package are beside the chunks that start them, once for every app.
  for (const [file, type] of [
    ['core-runtime/runtime/script-worker.js', /javascript/],
    ['core-runtime/zipp_torch.wasm', /^application\/wasm/],
  ] as const) {
    const response = await request.get(`/shared/assets/${file}`);
    expect(response.status(), file).toBe(200);
    expect(response.headers()['content-type'] ?? '', file).toMatch(type);
  }
});
