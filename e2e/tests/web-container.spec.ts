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

/**
 * The container draws into a closed shadow root, which nothing on the page can reach. The
 * spec keeps each root as it is attached, before any of the page's own scripts run.
 */
async function keepShadowRoots(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    const roots: ShadowRoot[] = [];
    (window as unknown as { __softnRoots: ShadowRoot[] }).__softnRoots = roots;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const root = attach.call(this, init);
      roots.push(root);
      return root;
    };
  });
}

/** What the containers on the page show, as text. */
const shown = (page: Page): Promise<string> =>
  page.evaluate(() =>
    ((window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? [])
      .map((root) => root.querySelector('[data-softn-viewport]')?.textContent ?? '')
      .join('\n')
  );

/** The middle of an element inside a container, for a real click on it. */
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate((sel) => {
    for (const root of (window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? []) {
      const el = root.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  }, selector);
  expect(box, `${selector} is drawn in the container`).not.toBeNull();
  return box!;
}

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

/** Open `buffer` through the workspace's "Open a .softn file" button. */
async function openBundle(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.goto('/web/');
  await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a .softn file', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
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
  const scripts = [...html.matchAll(/(?:src|href)="(\/web\/assets\/[^"]+\.js)"/g)].map((match) => match[1]);
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
    for (const chunk of [...listing.matchAll(/assets\/[\w.-]+\.js/g)].map((match) => `/web/${match[0]}`)) {
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
  // No app keeps a folder of its own: nothing there is a script. (A host answers 404; the
  // server these specs run on answers an app's unknown addresses with the app's page.)
  for (const app of ['web', 'studio', 'builder', 'play']) {
    const response = await request.get(`/${app}/assets/container-runtime/container-worker.js`);
    expect(response.status() === 404 || /^text\/html/.test(response.headers()['content-type'] ?? ''), app).toBe(true);
  }
});
