import { expect } from '@playwright/test';
import { containerBundle } from '../helpers/bundle';
import { keepShadowRoots, textIn } from '../helpers/container';
import { cachedWasm, fullEngine, requestedWasm } from '../helpers/engines';
import { test } from '../helpers/offlineSite';

// The editors' prompt-mode workers first control the page on reload. A preview
// opened by a direct link can already have used the full engine by then.
for (const editor of ['builder', 'studio']) {
  test(`${editor} reopens a classic Fieldnotes preview and runs its logic offline`, async ({ page, request, offlineSite }) => {
    test.setTimeout(150_000);
    const scope = `${offlineSite.origin}/${editor}/`;
    const bytes = await (await request.get('/examples/Fieldnotes.softn')).body();
    const worker = await (await request.get(scope + 'sw.js')).text();
    const config = JSON.parse(/^self\.__SOFTN_SW__=(.+);$/m.exec(worker)![1]);
    const renderer = (config.classicAssets.renderer as string[]).map(url => new URL(url, scope).pathname);
    expect(renderer.length).toBeGreaterThan(0);
    await page.goto(scope + '?open=/examples/Fieldnotes.softn&view=preview');
    const preview = editor === 'builder' ? page.frameLocator('iframe[title="Device Preview"]') : page;
    // Fieldnotes draws the form before its logic seeds the list and initial
    // input values. The first task is visible once its _init has completed.
    const seededTask = preview.getByRole('button', { name: 'Complete Sketch the welcome screen' });
    await expect(seededTask).toBeVisible({ timeout: 60_000 });
    await preview.locator('#fn-title').fill('Made online');
    await preview.getByRole('button', { name: /Add task/ }).click();
    await expect(preview.getByText('Made online', { exact: true })).toBeVisible();
    // The first page can draw before its prompt-mode worker is active. Wait
    // for the whole renderer to be saved before disconnecting this origin.
    await expect.poll(() => page.evaluate(async (paths) => {
      const buckets = await Promise.all((await caches.keys()).map(key => caches.open(key)));
      const saved = new Set((await Promise.all(buckets.map(cache => cache.keys()))).flat().map(req => new URL(req.url).pathname));
      return paths.every(path => saved.has(path));
    }, renderer), { timeout: 60_000 }).toBe(true);
    if (editor === 'studio') {
      await page.getByRole('button', { name: 'Tablet', exact: true }).click();
      await expect(page.getByRole('status', { name: /Saved to this browser/ })).toBeVisible();
    }
    offlineSite.disconnect();
    await page.reload();
    if (editor === 'builder') {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await (await chooser).setFiles({ name: 'Fieldnotes.softn', mimeType: 'application/octet-stream', buffer: bytes });
      await expect(page.getByTitle('Fieldnotes', { exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
    }
    await expect(seededTask).toBeVisible({ timeout: 60_000 });
    await preview.locator('#fn-title').fill('Made offline');
    await preview.getByRole('button', { name: /Add task/ }).click();
    await expect(preview.getByText('Made offline', { exact: true })).toBeVisible();
  });

  for (const app of [
    { name: 'Porch', value: 'Day 12', script: '"Day " + (3 * 4)', full: false },
    { name: 'Atlas', value: '12,000', script: 'new Intl.NumberFormat("en-US").format(12000)', full: true },
  ]) {
    test(`${editor} keeps the ${app.full ? 'full' : 'lite'} first preview working offline`, async ({ page, context, offlineSite }) => {
      test.setTimeout(180_000);
      const bytes = containerBundle({
        'manifest.json': JSON.stringify({ engine: 2, name: app.name, version: '1.0.0', main: 'index.html' }),
        'index.html': `<p id="result">Loading</p><script type="module">document.querySelector('#result').textContent = ${app.script};</script>`,
      });
      const filename = app.name + '.softn';
      const appPath = '/examples/' + filename;
      const requests = requestedWasm(context);
      await keepShadowRoots(page);
      await page.route(offlineSite.origin + appPath, route => route.fulfill({ body: bytes, contentType: 'application/zip' }));
      await page.goto(offlineSite.origin + `/${editor}/?open=${appPath}&view=preview`);
      const result = () => textIn(page, '#result');
      await expect.poll(result, { timeout: 60_000 }).toBe(app.value);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);
      expect([...requests].filter(path => fullEngine.test(path))).toHaveLength(app.full ? 1 : 0);
      expect((await cachedWasm(page)).filter(path => fullEngine.test(path))).toHaveLength(app.full ? 1 : 0);

      if (editor === 'studio') {
        await page.getByRole('button', { name: 'Tablet', exact: true }).click();
        await expect(page.getByRole('status', { name: /Saved to this browser/ })).toBeVisible();
      }
      await page.unroute(offlineSite.origin + appPath);
      offlineSite.disconnect();
      await page.reload();
      if (editor === 'builder') {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Open', exact: true }).click();
        await (await chooser).setFiles({ name: filename, mimeType: 'application/octet-stream', buffer: bytes });
        await expect(page.getByTitle(app.name, { exact: true }).first()).toBeVisible();
        await page.getByRole('button', { name: 'Preview', exact: true }).click();
      }
      await expect.poll(result, { timeout: 60_000 }).toBe(app.value);
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    });
  }
}
