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
import { centreOf, keepShadowRoots, openBundle, shown } from '../helpers/container';

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

test('a web container opened once online is installed, and opens from Home and runs with the network gone', async ({ page, context }, testInfo) => {
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
