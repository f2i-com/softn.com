/**
 * An app opened once online is installed, and then opens and works with the
 * network gone, as an installed PWA does. The runtime's service worker holds
 * the shell; the per-app install (apps/softn-web/src/lib/offlineInstall.ts)
 * fetches what this app's pages and code can reach and the shell does not
 * carry: the chart and Scene3D features (with Three.js and every loader and
 * effect a scene may ask for), the script worker the manifest runs its logic
 * in, the sandbox worker its code calls, and the AI runtime with the model
 * worker. The model is the app's own file, so it loads offline too.
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../helpers/offlineSite';
import { cachedWasm, fullEngine } from '../helpers/engines';
import { strToU8, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { tinyQwen3 } from '../../packages/@softn/core/test/helpers/tiny-gguf';
import { watchConsole } from '../helpers/console';

const NAME = 'Offline Everything';

const UI = `<logic src="../logic/main.logic" />

<App title="${NAME}">
  <Stack direction="vertical" gap="md" padding="xl">
    <Heading level={1}>${NAME}</Heading>
    <Text>Count: {count}</Text>
    <Text>Sandbox: {sandbox}</Text>
    <Text>Sum: {sum}</Text>
    <Text>Model: {model}</Text>
    <Button variant="primary" @click={() => bump()}>Bump</Button>
    <Button variant="secondary" @click={() => guest()}>Ask the sandbox</Button>
    <Button variant="secondary" @click={() => add()}>Add with WebAssembly</Button>
    <Button variant="secondary" @click={() => think()}>Ask the model</Button>
    <LineChart width={320} height={160} series={[{ name: "a", data: [{ x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: 3 }] }]} />
    <Scene3D width={320} height={200} />
  </Stack>
</App>
`;

const LOGIC = `let count = 0
let sandbox = "idle"
let sum = 0
let model = "idle"

function bump() {
  count = count + 1
}

function guest() {
  softn.sandbox.run("function update(input) { return input.n * 6 }", { n: 7 }, function(r) {
    sandbox = r && r.error ? "failed: " + r.error : "answered " + r.value
  })
}

function add() {
  softn.wasm.load("assets/calc.wasm", function(m) {
    softn.wasm.call(m.handle, "add", [2, 40], function(r) { sum = r.value })
  })
}

function think() {
  model = "loading"
  softn.ai.model.load({ bundle: "assets/tiny.gguf" }, { context: 256 }, function(r) {
    if (!r || r.error || !r.modelHandle) { model = "load failed: " + (r && r.error); return }
    softn.ai.model.generate(r.modelHandle, [{ role: "user", content: "hi" }], { do_sample: false, max_new_tokens: 2 }, function(g) {
      model = g && !g.error ? "answered " + g.finishReason : "generate failed: " + (g && g.error)
      softn.ai.model.release(r.modelHandle, function() {})
    })
  })
}
`;

function bundle(): Buffer {
  const manifest = {
    id: 'softn-e2e-offline-everything',
    name: NAME,
    version: '1.0.0',
    description: 'Built by the e2e gate.',
    main: 'ui/home.ui',
    files: { ui: ['ui/home.ui', 'ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets: ['assets/tiny.gguf', 'assets/calc.wasm'] },
    config: { execution: 'worker' },
  };
  const permissions = { ai: { enabled: true, allowedSources: ['bundle'], maxModelSizeMB: 8 } };
  return Buffer.from(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'permission.json': strToU8(JSON.stringify({ permissions })),
    'ui/home.ui': strToU8('<a href="main.ui">Open tools</a>'),
    'ui/main.ui': strToU8(UI),
    'logic/main.logic': strToU8(LOGIC),
    'assets/tiny.gguf': tinyQwen3().bytes,
    'assets/calc.wasm': Uint8Array.from(readFileSync(new URL('../../packages/@softn/core/test/fixtures/wasm/calc.wasm', import.meta.url))),
  }, { level: 6, mtime: new Date('2026-10-20T00:00:00.000Z') }));
}

async function usesEverything(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: NAME, exact: true })).toBeVisible({ timeout: 60_000 });
  // The page is drawn before its script has loaded; its state says when it has.
  await expect(page.getByText('Sandbox: idle', { exact: true })).toBeVisible({ timeout: 60_000 });
  const consent = page.locator('.softn-consent-bar .softn-consent-allow');
  if (await consent.count()) await consent.first().click();
  await page.getByRole('button', { name: 'Bump', exact: true }).click();
  await expect(page.getByText('Count: 1', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Ask the sandbox', exact: true }).click();
  await expect(page.getByText('Sandbox: answered 42', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add with WebAssembly', exact: true }).click();
  await expect(page.getByText('Sum: 42', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Ask the model', exact: true }).click();
  await expect(page.getByText(/^Model: answered (stop|length)$/)).toBeVisible({ timeout: 90_000 });
  const app = page.locator('.softn-app').first();
  await expect(app.locator('svg path').first()).toBeAttached({ timeout: 30_000 });
  await expect(app.locator('canvas').first()).toBeAttached({ timeout: 30_000 });
}

test('an app opened once online opens from Home and works with the network gone', async ({ page, offlineSite }, testInfo) => {
  test.setTimeout(240_000);
  const log = watchConsole(page, testInfo);
  try {
    await page.goto(offlineSite.origin + '/web/');
    await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
    // The install waits for the service worker to control the page; so does this.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 60_000 });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open file', exact: true }).click();
    await (await chooser).setFiles({ name: 'OfflineEverything.softn', mimeType: 'application/octet-stream', buffer: bundle() });
    // Leave the tools page unvisited. Its dependencies must be installed without
    // first running a script, rendering its charts, or calling its Wasm module.
    const tools = page.getByRole('link', { name: 'Open tools' });
    await expect(tools).toBeVisible();

    // Home says when the install has everything.
    await page.locator('.softn-frame-home').first().click();
    const card = page.getByRole('button', { name: `Open ${NAME}`, exact: true });
    await expect(card.locator('.softn-launcher-offline')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
    expect(await cachedWasm(page)).toContainEqual(expect.stringMatching(fullEngine));

    for (const group of ['charts', 'scene3d']) {
      expect([...offlineSite.requestedPaths].some(path => path.includes('/' + group + '-'))).toBe(true);
    }
    offlineSite.disconnect();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: `Open ${NAME}`, exact: true }).click();
    await tools.click();
    await usesEverything(page);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('offline-app');
  }
});

test('a linked Python page runs its declared torch package on its first offline visit', async ({ page, offlineSite }) => {
  test.setTimeout(120_000);
  const name = 'Offline Python tools';
  const manifest = {
    name, main: 'home.ui',
    files: { ui: ['home.ui', 'sum.ui'], logic: ['sum.py'] },
    config: { python: { packages: ['torch'] } },
  };
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'home.ui': strToU8('<a href="sum.ui">Open sum</a>'),
    'sum.ui': strToU8('<logic src="sum.py" /><Text>Sum: {total}</Text>'),
    'sum.py': strToU8('import torch\ntotal = int(torch.tensor([20.0, 22.0]).sum())\n'),
  });
  await page.goto(offlineSite.origin + '/web/');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  await (await chooser).setFiles({ name: 'Sum.softn', mimeType: 'application/octet-stream', buffer: Buffer.from(archive) });
  const link = page.getByRole('link', { name: 'Open sum' });
  await expect(link).toBeVisible();
  await page.locator('.softn-frame-home').first().click();
  const card = page.getByRole('button', { name: `Open ${name}`, exact: true });
  await expect(card.locator('.softn-launcher-offline')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  offlineSite.disconnect();
  await page.reload();
  await card.click();
  await link.click();
  await expect(page.getByText('Sum: 42', { exact: true })).toBeVisible({ timeout: 30_000 });
});
