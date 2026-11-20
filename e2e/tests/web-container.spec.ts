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
import { centreOf, clickIn, keepShadowRoots, openBundle, seeIn, shown, textIn } from '../helpers/container';
import fs from 'node:fs';
import zlib from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

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
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('plain-counter');
  }
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

test('a web container opened once online is installed, and opens from Home and runs with the network gone', async ({ page, context, browserName }, testInfo) => {
  // Measured: Playwright's WebKit on Windows cannot reload any page a service worker serves
  // once the network is off ("WebKit encountered an internal error", a page of three lines
  // and a worker of four as well); Chromium and Firefox do. The install itself is checked
  // there up to that point by the steps before it in the other browsers' runs.
  test.skip(browserName === 'webkit' && process.platform === 'win32', 'Playwright’s WebKit on Windows does not reload a page from its service worker offline');
  test.setTimeout(240_000);
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const NAME = 'Offline Shop';
  try {
    await page.goto('/web/');
    await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
    // The install waits for the service worker to control the page; so does this.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 60_000 });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open a .softn file', exact: true }).click();
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

    await context.setOffline(true);
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
    await context.setOffline(false);
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
    document.getElementById('picked').textContent = file ? file.name + ':' + file.size + ':' + (await file.slice(0, 5).text()) + ':' + (await file.slice(-3).text()) : 'no file was handed over';
  });
  // Said by the script: the runtime's "Starting…" is over the app until its script has run.
  document.getElementById('picked').textContent = 'nothing picked';
</script>
</body>
</html>`;

test('a file is saved only at the person’s word, in the page’s own bar, and a picked file is read only by an app allowed files', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const pickFile = async (name = 'note.txt', buffer = Buffer.from('hello')) => {
    const chooser = page.waitForEvent('filechooser');
    await clickIn(page, '#pick');
    await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer });
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
    await expect.poll(() => textIn(page, '#picked')).toBe('note.txt:5:hello:llo');
    // A file of megabytes is heard of at once, and a part of it is read without the whole.
    const large = new Uint8Array(6 * 1024 * 1024).fill(65);
    large.set([101, 110, 100], large.length - 3);
    await pickFile('film.bin', Buffer.from(large));
    await expect.poll(() => textIn(page, '#picked'), { timeout: 30_000 }).toBe(`film.bin:${large.length}:AAAAA:end`);
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
    // A feed says it is there at once, as feeds do: Firefox and WebKit answer a request when
    // the first of its body arrives, not with its head (Chromium answers with the head).
    if (path === '/feed') response.write(': ready\n\n');
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

    // Each piece as the server writes it: the app has one before the next exists. (The head
    // comes with the first piece in Firefox and WebKit, before it in Chromium.)
    await clickIn(page, '#go');
    await expect.poll(() => held['/words'].length).toBe(1);
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

// What an app keeps, and what it reads back. IndexedDB is the app's side's own, kept through
// the Worker in the page's storage: here it is opened in a real Worker, and found again when
// the same app is opened again. A script file past what the engine compiles at run time
// (64 KB) is written into the app's program. And a canvas is read back at once from a
// canvas the Worker keeps beside it: a real OffscreenCanvas, a real picture.
const LONG_SCRIPT = `/* ${'a library of some size, as libraries are. '.repeat(2200)} */
var visits = { label: 'visit' };
function describeVisit(n) { return visits.label + ' ' + n; }`;

const KEEPER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Keeper</title></head>
<body>
<canvas id="c" width="20" height="10"></canvas>
<canvas id="order" width="4" height="4"></canvas>
<canvas id="reset" width="4" height="4"></canvas>
<canvas id="sprite" width="4" height="4"></canvas>
<canvas id="moved" width="4" height="4"></canvas>
<div id="box"></div>
<img id="copy" alt="">
<p id="seen">starting</p>
<script src="long.js"></script>
<script>
  const say = (what) => { document.getElementById('seen').textContent = what; };
  // A canvas to be cleared later by setting its size to the one it has.
  const blue = document.getElementById('reset').getContext('2d');
  blue.fillStyle = 'rgb(0, 0, 255)';
  blue.fillRect(0, 0, 4, 4);
  // A canvas to be moved later, with what is drawn on it.
  const moved = document.getElementById('moved').getContext('2d');
  moved.fillStyle = 'rgb(0, 0, 255)';
  moved.fillRect(0, 0, 4, 4);
  // A game's sprite: an image on no page, drawn into a canvas when it has loaded.
  const sprite = new Image();
  // At its own size: scaled, a browser's smoothing fades its edges.
  sprite.onload = () => document.getElementById('sprite').getContext('2d').drawImage(sprite, 1, 1);
  sprite.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const opening = indexedDB.open('visits', 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('counts');
  opening.onerror = () => say('failed: ' + opening.error);
  opening.onsuccess = () => {
    const tx = opening.result.transaction('counts', 'readwrite');
    const store = tx.objectStore('counts');
    const kept = store.get('n');
    let n = 0;
    kept.onsuccess = () => { n = (kept.result || 0) + 1; store.put(n, 'n'); };
    tx.oncomplete = () => {
      const canvas = document.getElementById('c');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgb(255, 0, 0)';
      ctx.fillRect(0, 0, 10, 10);
      const red = Array.from(ctx.getImageData(5, 5, 1, 1).data).join(',');
      const clear = Array.from(ctx.getImageData(15, 5, 1, 1).data).join(',');
      const address = canvas.toDataURL();
      document.getElementById('copy').src = address;
      // Drawn on first in this turn, then drawn into from a canvas drawn on after it: the
      // page drew each canvas's drawing in turn, and this one copied a canvas still blank.
      const order = document.getElementById('order').getContext('2d');
      order.clearRect(0, 0, 4, 4);
      const buffer = document.createElement('canvas');
      buffer.width = 4;
      buffer.height = 4;
      const green = buffer.getContext('2d');
      green.fillStyle = 'rgb(0, 255, 0)';
      green.fillRect(0, 0, 4, 4);
      order.drawImage(buffer, 0, 0);
      const reset = document.getElementById('reset');
      reset.width = reset.width;
      document.getElementById('box').appendChild(document.getElementById('moved'));
      say(describeVisit(n) + ' | ' + red + ' | ' + clear + ' | ' + address.slice(0, 22));
    };
  };
</script>
</body>
</html>`;

test('an app keeps what it keeps in IndexedDB and finds it again, runs a script file of any size, and reads its canvas back at once', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const bundle = containerBundle({ 'index.html': KEEPER, 'long.js': LONG_SCRIPT });
  expect(new TextEncoder().encode(LONG_SCRIPT).length, 'the script is past what the engine compiles at run time').toBeGreaterThan(64 * 1024);
  // A canvas is read back from a canvas the Worker keeps, which needs an OffscreenCanvas in a
  // Worker. A browser without one (Playwright's WebKit on Windows) answers as the fallback
  // does: a transparent picture and an empty address, and the app is told why.
  const readable = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const probe = new Worker(URL.createObjectURL(new Blob(["postMessage(typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d'))"], { type: 'text/javascript' })));
        probe.onmessage = (event) => resolve(event.data === true);
        probe.onerror = () => resolve(false);
      })
  );
  const read = readable ? '255,0,0,255 | 0,0,0,0 | data:image/png;base64,' : '0,0,0,0 | 0,0,0,0 | data:,';
  try {
    await openBundle(page, 'Keeper.softn', bundle);
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe(`visit 1 | ${read}`);
    // On the page's own canvases: the copy has what the buffer on no page had, the canvas set
    // to its own size is cleared, the sprite made with new Image() is drawn, and the canvas
    // moved keeps what was drawn on it.
    const drawn = () =>
      page.evaluate(() => {
        const pixel = (id: string) => {
          for (const root of (window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? []) {
            const canvas = root.querySelector(`#${id}`) as HTMLCanvasElement | null;
            if (canvas) return Array.from(canvas.getContext('2d')!.getImageData(1, 1, 1, 1).data).join(',') + (canvas.parentElement?.id ? ` in ${canvas.parentElement.id}` : '');
          }
          return null;
        };
        return { order: pixel('order'), reset: pixel('reset'), sprite: pixel('sprite'), moved: pixel('moved') };
      });
    await expect.poll(drawn).toEqual({ order: '0,255,0,255', reset: '0,0,0,0', sprite: '255,0,0,255', moved: '0,0,255,255 in box' });
    if (readable) {
      // The picture the app read back is a picture: the page shows it, at the canvas's size.
      await expect.poll(async () => (await seeIn(page, '#copy'))?.loaded).toBe(true);
      const copy = await page.evaluate(() => {
        for (const root of (window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? []) {
          const img = root.querySelector('#copy') as HTMLImageElement | null;
          if (img) return [img.naturalWidth, img.naturalHeight];
        }
        return null;
      });
      expect(copy).toEqual([20, 10]);
    } else {
      expect(log.all.some((line) => line.includes('cannot be read back at once'))).toBe(true);
    }
    // The same app, opened again: what it kept is there.
    await openBundle(page, 'Keeper.softn', bundle);
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe(`visit 2 | ${read}`);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('keeper');
  }
});

// The same app open in two tabs, each adding records to one store: each reads what the other
// kept before it writes. (Each kept the store as it read it when it started, and wrote the
// other's records away.)
const TWO_TABS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Two Tabs</title></head>
<body>
<button id="add" type="button">Add</button>
<button id="show" type="button">Show</button>
<button id="burst" type="button">Burst</button>
<button id="count" type="button">Count</button>
<button id="big" type="button">Big</button>
<button id="readBig" type="button">Read big</button>
<p id="seen">starting</p>
<script>
  const me = Math.random().toString(36).slice(2, 8);
  let added = 0;
  let db = null;
  const say = (what) => { document.getElementById('seen').textContent = what; };
  const opening = indexedDB.open('shared', 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('notes');
    opening.result.createObjectStore('log', { autoIncrement: true });
    opening.result.createObjectStore('big');
  };
  opening.onsuccess = () => { db = opening.result; say('ready'); };
  const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  // Records with keys the database makes, one transaction each, as fast as the app can.
  document.getElementById('burst').addEventListener('click', async () => {
    for (let i = 0; i < 15; i++) {
      const tx = db.transaction('log', 'readwrite');
      tx.objectStore('log').add(me + ' ' + i);
      await finished(tx);
    }
    say('burst done');
  });
  document.getElementById('count').addEventListener('click', () => {
    const read = db.transaction('log').objectStore('log').count();
    read.onsuccess = () => say('log ' + read.result);
  });
  // More than the page's localStorage holds (about 5 MB): three stores' worth of 2.5 million characters.
  document.getElementById('big').addEventListener('click', async () => {
    try {
      for (let i = 1; i <= 3; i++) {
        const tx = db.transaction('big', 'readwrite');
        tx.objectStore('big').put(String(i).repeat(2500000), 'part' + i);
        await finished(tx);
      }
      say('big kept');
    } catch (e) { say('big failed ' + (e && e.name)); }
  });
  document.getElementById('readBig').addEventListener('click', () => {
    const read = db.transaction('big').objectStore('big').get('part2');
    read.onsuccess = () => say('big read ' + (read.result ? read.result.length + ' ' + read.result.charAt(0) : 'nothing'));
  });
  document.getElementById('add').addEventListener('click', () => {
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put('note', me + '-' + (++added));
    tx.oncomplete = () => say('added ' + added);
  });
  document.getElementById('show').addEventListener('click', () => {
    const read = db.transaction('notes').objectStore('notes').getAllKeys();
    read.onsuccess = () => say('keys ' + read.result.length);
  });
</script>
</body>
</html>`;

test('the same app open in two tabs keeps what each adds', async ({ context }) => {
  test.setTimeout(240_000);
  const bundle = containerBundle({ 'index.html': TWO_TABS });
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await keepShadowRoots(page);
    await openBundle(page, 'TwoTabs.softn', bundle);
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
  }
  const add = async (page: typeof first, n: number) => {
    await clickIn(page, '#add');
    await expect.poll(() => textIn(page, '#seen')).toBe(`added ${n}`);
  };
  // Each tab reads again as it is shown its count: the other's records arrive a moment after they are kept.
  const keys = (page: typeof first, count: number) =>
    expect
      .poll(async () => {
        await clickIn(page, '#show');
        return textIn(page, '#seen');
      }, { timeout: 15_000 })
      .toBe(`keys ${count}`);
  await add(first, 1);
  await add(second, 1);
  await keys(first, 2);
  await keys(second, 2);
  await add(first, 2);
  await add(second, 2);
  await keys(first, 4);
  await keys(second, 4);
  // Both at once, with keys the database makes: each tab writes while it holds the database,
  // from what the other kept, so no record of one is written over by the other's.
  await Promise.all([clickIn(first, '#burst'), clickIn(second, '#burst')]);
  for (const page of [first, second]) await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('burst done');
  for (const page of [first, second]) {
    await expect
      .poll(async () => {
        await clickIn(page, '#count');
        return textIn(page, '#seen');
      }, { timeout: 15_000 })
      .toBe('log 30');
  }
  // More than the page's localStorage could hold: kept in the page's own IndexedDB, and read in the other tab.
  await clickIn(first, '#big');
  await expect.poll(() => textIn(first, '#seen'), { timeout: 60_000 }).toBe('big kept');
  await expect
    .poll(async () => {
      await clickIn(second, '#readBig');
      return textIn(second, '#seen');
    }, { timeout: 30_000 })
    .toBe('big read 2500000 2');
  expect(await first.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('idb:')).length)).toBe(0);
  await first.close();
  await second.close();
});

test('the same app open in two tabs keeps what each adds where the browser has no locks of its own', async ({ context }) => {
  // Safari before 15.4 has no navigator.locks: a lease in the page's IndexedDB holds a database instead.
  test.setTimeout(240_000);
  const bundle = containerBundle({ 'index.html': TWO_TABS });
  const pages = [await context.newPage(), await context.newPage()];
  for (const page of pages) {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });
    });
    await keepShadowRoots(page);
    await openBundle(page, 'NoLocks.softn', bundle);
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
  }
  expect(await pages[0].evaluate(() => typeof navigator.locks)).toBe('undefined');
  await Promise.all(pages.map((page) => clickIn(page, '#burst')));
  for (const page of pages) await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('burst done');
  for (const page of pages) {
    await expect
      .poll(async () => {
        await clickIn(page, '#count');
        return textIn(page, '#seen');
      }, { timeout: 15_000 })
      .toBe('log 30');
  }
  for (const page of pages) await page.close();
});

// A thumbnail of a picture the person picks, made as apps make one: an address for the file,
// an image loaded from it, drawn small on a canvas on no page, and read back at once. The
// picture was registered for the Worker's copy before its bytes reached the Worker, and taken
// for one that could not be decoded: the thumbnail was blank.
const THUMBS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Thumbs</title></head>
<body>
<input id="pick" type="file" accept="image/*">
<p id="seen">starting</p>
<script>
  const pick = document.getElementById('pick');
  pick.addEventListener('change', () => {
    const file = pick.files[0];
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 32, 32);
      const thumb = canvas.toDataURL('image/png');
      const px = Array.from(ctx.getImageData(16, 16, 1, 1).data);
      URL.revokeObjectURL(url);
      document.getElementById('seen').textContent = file.name + ' ' + thumb.slice(0, 22) + ' ' + (thumb.length > 100) + ' ' + px.join(',');
    };
    img.src = url;
  });
  document.getElementById('seen').textContent = 'ready';
</script>
</body>
</html>`;

/** A PNG of `side` pixels a side: red all over, or noise, which no compressor makes smaller. */
function testPng(side: number, noisy: boolean): Buffer {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, zlib.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, side);
  new DataView(header.buffer).setUint32(4, side);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array(side * (side * 4 + 1));
  let seed = 9;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const at = y * (side * 4 + 1) + 1 + x * 4;
      if (noisy) {
        for (let k = 0; k < 3; k++) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          raw[at + k] = seed >>> 24;
        }
        raw[at + 3] = 255;
      } else raw.set([255, 0, 0, 255], at);
    }
  }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', new Uint8Array(zlib.deflateSync(raw, { level: 0 }))), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return Buffer.from(png);
}
test('a thumbnail of a picture the person picks is drawn and read back at once', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const readable = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const probe = new Worker(URL.createObjectURL(new Blob(["postMessage(typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d'))"], { type: 'text/javascript' })));
        probe.onmessage = (event) => resolve(event.data === true);
        probe.onerror = () => resolve(false);
      })
  );
  try {
    await openBundle(page, 'Thumbs.softn', containerBundle({ 'index.html': THUMBS, 'permission.json': JSON.stringify({ permissions: { files: { enabled: true } } }) }));
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
    await page.locator('[data-softn-consent]').getByRole('button', { name: 'Allow', exact: true }).click();
    const pickPicture = async (name: string, png: Buffer) => {
      const chooser = page.waitForEvent('filechooser');
      await clickIn(page, '#pick');
      await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: png });
    };
    await pickPicture('red.png', testPng(64, false));
    await expect.poll(() => textIn(page, '#seen'), { timeout: 30_000 }).toBe(readable ? 'red.png data:image/png;base64, true 255,0,0,255' : 'red.png data:, false 0,0,0,0');
    // A photograph's size (more than 4 MB): an image on no page is decoded whatever its size.
    const large = testPng(1100, true);
    expect(large.length).toBeGreaterThan(4 * 1024 * 1024);
    await pickPicture('large.png', large);
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toMatch(readable ? /^large\.png data:image\/png;base64, true \d+,\d+,\d+,255$/ : /^large\.png data:, false 0,0,0,0$/);
    expect(log.all.filter((line) => line.includes('lacks it'))).toEqual([]);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('thumbs');
  }
});

// An app that stops (here, an eval of more than the engine compiles at once while an app runs)
// says so on the page, and starts again at the person's word.
const STOPS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Stops</title></head>
<body>
<button id="stop" type="button">Stop</button>
<p id="seen">starting</p>
<script>
  document.getElementById('stop').addEventListener('click', () => {
    document.getElementById('seen').textContent = 'stopping';
    (0, eval)('/*' + 'x'.repeat(70000) + '*/ 1');
  });
  // Set by the script: the page's own words are there, under the runtime's cover, before it runs.
  document.getElementById('seen').textContent = 'started';
</script>
</body>
</html>`;

test('an app that stops says so on the page, and starts again', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  try {
    await openBundle(page, 'Stops.softn', containerBundle({ 'index.html': STOPS }));
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('started');
    await clickIn(page, '#stop');
    await expect.poll(() => textIn(page, '[data-softn-stopped-bar]'), { timeout: 15_000 }).toContain('stopped: it compiled more code at once');
    await clickIn(page, '[data-softn-stopped-restart]');
    await expect.poll(() => textIn(page, '[data-softn-stopped-bar]')).toBeNull();
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('started');
    // Started again, it answers.
    await clickIn(page, '#stop');
    await expect.poll(() => textIn(page, '[data-softn-stopped-bar]'), { timeout: 15_000 }).toContain('stopped');
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('stops');
  }
});

// A list that draws only the rows in view, as react-window and TanStack Virtual do: it reads
// where the person has scrolled it. It read 0 wherever the person scrolled (the app was never
// told), and a scroll listener on the window was never called. And crypto.subtle, done by the
// browser's own.
const SCROLLED = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scrolled</title></head>
<body>
<div id="list" style="height: 200px; overflow: auto; border: 1px solid #999"><div style="height: 20000px; position: relative"><div id="rows" style="position: absolute; left: 0; right: 0"></div></div></div>
<p id="seen">starting</p>
<p id="win">window 0</p>
<p id="crypto">crypto</p>
<div style="height: 3000px">tall</div>
<script>
  const list = document.getElementById('list');
  const rows = document.getElementById('rows');
  const draw = () => {
    const first = Math.floor(list.scrollTop / 20);
    rows.style.top = first * 20 + 'px';
    rows.textContent = '';
    for (let i = first; i < first + 12; i++) {
      const row = document.createElement('div');
      row.style.height = '20px';
      row.textContent = 'row ' + i;
      rows.appendChild(row);
    }
    document.getElementById('seen').textContent = 'first ' + first;
  };
  list.addEventListener('scroll', draw);
  window.addEventListener('scroll', () => { document.getElementById('win').textContent = window.scrollY > 0 ? 'window moved' : 'window 0'; });
  draw();
  (async () => {
    const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
    const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('secret'));
    const opened = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed));
    document.getElementById('crypto').textContent = digest.slice(0, 8) + ' ' + opened + ' ' + (key instanceof CryptoKey);
  })().catch((e) => { document.getElementById('crypto').textContent = 'failed ' + e.name + ' ' + e.message; });
</script>
</body>
</html>`;

test('a list reads where the person scrolled it, the window hears its own scroll, and crypto.subtle is the browser’s', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  try {
    await openBundle(page, 'Scrolled.softn', containerBundle({ 'index.html': SCROLLED }));
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('first 0');
    await expect.poll(() => textIn(page, '#crypto'), { timeout: 30_000 }).toBe('ba7816bf secret true');
    const list = await centreOf(page, '#list');
    await page.mouse.move(list.x, list.y);
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => textIn(page, '#seen'), { timeout: 15_000 }).toMatch(/^first [1-9]\d*$/);
    // The rows drawn are the ones in view.
    const first = Number((await textIn(page, '#seen'))?.split(' ')[1]);
    expect(await textIn(page, '#rows')).toContain(`row ${first}`);
    // The app's page itself, scrolled from below the list.
    const below = await centreOf(page, '#win');
    await page.mouse.move(below.x, below.y);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => textIn(page, '#win'), { timeout: 15_000 }).toBe('window moved');
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('scrolled');
  }
});

// A picture from another site, asked for with CORS from a site that allows it: a canvas it is
// drawn into is read back, as in a browser. One asked for without stays unreadable.
const CORS_PICTURES = (port: number) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Pictures</title></head>
<body>
<button id="go" type="button">Go</button>
<canvas id="c" width="4" height="4"></canvas><canvas id="d" width="4" height="4"></canvas><canvas id="e" width="4" height="4"></canvas>
<img id="onpage" crossorigin="anonymous" alt="">
<p id="seen">starting</p>
<script>
  const withCors = new Image();
  withCors.crossOrigin = 'anonymous';
  const without = new Image();
  // And one on the page, asked for with CORS: the page's own canvas reads it back too.
  const onPage = document.getElementById('onpage');
  let loaded = 0;
  const all = () => {
    if (++loaded < 3) return;
    const c = document.getElementById('c');
    const d = document.getElementById('d');
    const e = document.getElementById('e');
    c.getContext('2d').drawImage(withCors, 0, 0);
    d.getContext('2d').drawImage(without, 0, 0);
    e.getContext('2d').drawImage(onPage, 0, 0);
    const px = Array.from(c.getContext('2d').getImageData(1, 1, 1, 1).data).join(',');
    let taint;
    try { d.toDataURL(); taint = 'read'; } catch (err) { taint = err.name; }
    c.toBlob((blob) => {
      e.toBlob((fromPage) => { document.getElementById('seen').textContent = px + ' ' + taint + ' ' + (blob instanceof Blob) + ' ' + (fromPage instanceof Blob); });
    });
  };
  withCors.onload = all;
  without.onload = all;
  onPage.onload = all;
  withCors.onerror = without.onerror = onPage.onerror = () => { document.getElementById('seen').textContent = 'not loaded'; };
  document.getElementById('go').addEventListener('click', () => {
    withCors.src = 'http://127.0.0.1:${port}/cors.png';
    without.src = 'http://127.0.0.1:${port}/plain.png';
    onPage.src = 'http://127.0.0.1:${port}/cors.png?on-page';
  });
  document.getElementById('seen').textContent = 'ready';
</script>
</body>
</html>`;

test('a picture asked for with CORS from a site that allows it leaves its canvas readable, and is asked for without cookies', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  const red = testPng(4, false);
  const asked: Array<{ path: string; origin: string | undefined; cookie: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    asked.push({ path, origin: request.headers.origin, cookie: request.headers.cookie });
    if (path === '/cors.png') response.setHeader('access-control-allow-origin', '*');
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(red);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const readable = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const probe = new Worker(URL.createObjectURL(new Blob(["postMessage(typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d'))"], { type: 'text/javascript' })));
        probe.onmessage = (event) => resolve(event.data === true);
        probe.onerror = () => resolve(false);
      })
  );
  try {
    await openBundle(
      page,
      'Pictures.softn',
      containerBundle({
        'index.html': CORS_PICTURES(port),
        'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allow_http: true, allowed_hosts: ['127.0.0.1'] } } }),
      })
    );
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
    await page.locator('[data-softn-consent]').getByRole('button', { name: 'Allow', exact: true }).click();
    await clickIn(page, '#go');
    // The page's own canvas is readable too: toBlob gives the picture.
    await expect.poll(() => textIn(page, '#seen'), { timeout: 30_000 }).toBe(readable ? '255,0,0,255 SecurityError true true' : '0,0,0,0 read true true');
    expect(asked.some((one) => one.path === '/cors.png' && one.origin !== undefined)).toBe(true);
    expect(asked.every((one) => one.cookie === undefined)).toBe(true);
    expect(log.uncaught).toEqual([]);
  } finally {
    server.close();
    await log.attach('cors-pictures');
  }
});

// Workers of the app's own: a script file, a module that imports another, and a blob of
// script; each answers in a worker's scope, reads the app's files, keeps its timers and
// hashes with crypto.subtle; and the person can still use the app while they work.
const WORKERS = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Workers</title></head>
<body>
<button id="go" type="button">Go</button>
<button id="tap" type="button">Tap</button>
<button id="rally" type="button">Rally</button>
<p id="seen">starting</p>
<p id="taps">taps 0</p>
<p id="rallied">no rally</p>
<script>
  const results = {};
  const done = () => {
    if (Object.keys(results).length < 3) return;
    document.getElementById('seen').textContent = [results.classic, results.module, results.inline].join(' | ');
  };
  document.getElementById('go').addEventListener('click', () => {
    const classic = new Worker('classic.js');
    classic.onmessage = (e) => { results.classic = e.data; done(); };
    classic.postMessage({ words: ['a', 'b'], bytes: new Uint8Array([7, 8]) });
    const modular = new Worker('module.js', { type: 'module' });
    modular.onmessage = (e) => { results.module = e.data; done(); };
    modular.postMessage(5);
    const inline = new Worker(URL.createObjectURL(new Blob(['onmessage = (e) => postMessage(typeof document + " " + (e.data * 3));'], { type: 'text/javascript' })));
    inline.onmessage = (e) => { results.inline = e.data; done(); };
    inline.postMessage(7);
  });
  let taps = 0;
  document.getElementById('tap').addEventListener('click', () => { document.getElementById('taps').textContent = 'taps ' + (++taps); });
  // A thousand round trips, as Comlink's calls make them: each message in a task of its own,
  // and a timer set on the way runs on the way, as in a browser.
  document.getElementById('rally').addEventListener('click', () => {
    const echo = new Worker(URL.createObjectURL(new Blob(['onmessage = (e) => postMessage(e.data + 1);'], { type: 'text/javascript' })));
    const order = [];
    echo.onmessage = (e) => {
      if (e.data === 1) setTimeout(() => order.push('inner'), 0);
      if (e.data < 1000) { echo.postMessage(e.data); return; }
      document.getElementById('rallied').textContent = 'rallied ' + e.data + ' ' + order.join(',');
      echo.terminate();
    };
    echo.postMessage(0);
    setTimeout(() => order.push('outer'), 0);
  });
  document.getElementById('seen').textContent = 'ready';
</script>
</body>
</html>`;

test('an app runs Workers of its own: a script file, a module and a blob of script, each in a worker’s scope', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  try {
    await openBundle(
      page,
      'Workers.softn',
      containerBundle({
        'index.html': WORKERS,
        'classic.js': `onmessage = async (e) => {
          const data = await (await fetch('data.json')).json();
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
          setTimeout(() => postMessage(e.data.words.join('') + ' ' + e.data.bytes[1] + ' ' + data.n + ' ' + digest[0].toString(16)), 30);
        };`,
        'math.js': 'export const square = (n) => n * n;',
        'module.js': `import { square } from './math.js';
          self.addEventListener('message', (e) => self.postMessage('square ' + square(e.data) + ' ' + (self instanceof DedicatedWorkerGlobalScope)));`,
        'data.json': JSON.stringify({ n: 3 }),
      })
    );
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('ready');
    await clickIn(page, '#go');
    await expect.poll(() => textIn(page, '#seen'), { timeout: 30_000 }).toBe('ab 8 3 ba | square 25 true | undefined 21');
    await clickIn(page, '#tap');
    await expect.poll(() => textIn(page, '#taps')).toBe('taps 1');
    await clickIn(page, '#rally');
    await expect.poll(() => textIn(page, '#rallied'), { timeout: 60_000 }).toBe('rallied 1000 outer,inner');
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('workers');
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

// Scripts in the app's document: a webpack-style build (its bundle deferred in the head, after
// the page's own script that sets what it reads; where its parts are found by
// document.currentScript; a part over 64 KB loaded by a script it adds), a script of text run as
// it joins the document (jQuery's DOMEval), a template kept in a script, and a nomodule script
// that is not run.
const SCRIPTS_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scripts</title>
<script defer src="static/js/main.js"></script>
</head>
<body>
<p id="seen">starting</p>
<script type="text/x-template" id="row"><li class="row">{{ name }}</li></script>
<script nomodule>window.legacy = true;</script>
<script>window.__ENV__ = { greeting: 'hello' };</script>
</body>
</html>`;

const SCRIPTS_MAIN = `
var scriptUrl = document.currentScript && document.currentScript.src;
if (!scriptUrl) throw new Error('Automatic publicPath is not supported in this browser');
var publicPath = scriptUrl.replace(/#.*$/, '').replace(/\\?.*$/, '').replace(/\\/[^\\/]+$/, '/');
var results = [window.__ENV__ ? window.__ENV__.greeting : 'no env'];
var evaluated = document.createElement('script');
evaluated.text = 'window.domEval = "ran";';
document.head.appendChild(evaluated).parentNode.removeChild(evaluated);
results.push(window.domEval);
results.push(document.getElementById('row').textContent);
results.push(String(window.legacy));
var chunks = self.webpackChunkapp = self.webpackChunkapp || [];
chunks.push = function (entry) {
  results.push(entry[1].lazy());
  document.getElementById('seen').textContent = results.join(' | ');
};
var part = document.createElement('script');
part.src = publicPath + 'lazy.chunk.js';
part.onerror = function () { document.getElementById('seen').textContent = 'the part did not load'; };
document.head.appendChild(part);
`;

test('scripts in an app’s document: a webpack build’s deferred bundle and the part it adds, a script of text, a template, nomodule', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await keepShadowRoots(page);
  try {
    await openBundle(
      page,
      'Scripts.softn',
      containerBundle({
        'index.html': SCRIPTS_PAGE,
        'static/js/main.js': SCRIPTS_MAIN,
        'static/js/lazy.chunk.js': `/* ${'a part of a build, as parts are. '.repeat(3000)} */\n(self.webpackChunkapp = self.webpackChunkapp || []).push([["lazy"], { lazy: function () { return "lazy part"; } }]);`,
      })
    );
    await expect.poll(() => textIn(page, '#seen'), { timeout: 60_000 }).toBe('hello | ran | <li class="row">{{ name }}</li> | undefined | lazy part');
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('scripts');
  }
});