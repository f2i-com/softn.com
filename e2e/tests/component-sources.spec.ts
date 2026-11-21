import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { test } from '../helpers/offlineSite';
import { clickIn, keepShadowRoots, openBundle, textIn } from '../helpers/container';
import { BUILDER_EXPORT_DIALOG } from '../helpers/editors';

const formats = [
  { id: 'jsx', name: 'React', studioLabel: 'React JSX', builderLabel: 'JSX', file: 'App.jsx', app: 'Practice set' },
  { id: 'vue', name: 'Vue', studioLabel: 'Vue SFC', builderLabel: 'Vue single-file component', file: 'App.vue', app: 'Reading log' },
] as const;

async function exportProject(page: Page, editor: string, info: TestInfo, version: string) {
  if (editor === 'builder') await page.getByRole('button', { name: 'Export', exact: true }).click();
  const action = editor === 'studio' ? page.getByRole('button', { name: 'Export bundle', exact: true })
    : page.getByRole('dialog', { name: BUILDER_EXPORT_DIALOG }).getByRole('button', { name: 'Export .softn', exact: true });
  const [download] = await Promise.all([page.waitForEvent('download'), action.click()]);
  const archive = info.outputPath(version + '.softn');
  await download.saveAs(archive);
  return { bytes: await readFile(archive), name: download.suggestedFilename() };
}

async function cachedPaths(page: Page) {
  return page.evaluate(async () => {
    const buckets = await Promise.all((await caches.keys()).map(key => caches.open(key)));
    return (await Promise.all(buckets.map(cache => cache.keys()))).flat().map(req => new URL(req.url).pathname);
  });
}

for (const editor of ['builder', 'studio']) {
  for (const format of formats) {
    test(`${editor} edits ${format.file} after a disconnected reload and exports it for offline Runtime`, async ({ browser, page, request, offlineSite }, info) => {
      test.setTimeout(180_000);
      const scope = offlineSite.origin + '/' + editor + '/';
      const sw = await (await request.get(scope + 'sw.js')).text();
      const config = JSON.parse(/^self\.__SOFTN_SW__=(.+);$/m.exec(sw)![1]);
      const paths = (key: string): string[] => config.sourceCompilers[key].map((url: string) => new URL(url, scope).pathname);
      const own = paths(format.id);
      const unused = paths(format.id === 'jsx' ? 'vue' : 'jsx').filter(path => !own.includes(path));
      expect(own.length).toBeGreaterThan(0);
      expect(unused.length).toBeGreaterThan(0);
      await keepShadowRoots(page);
      await page.goto(scope);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      expect([...own, ...unused].filter(path => offlineSite.requestedPaths.has(path))).toEqual([]);

      if (editor === 'studio') {
        await page.getByRole('button', { name: 'Create ' + format.studioLabel + ' starter', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'New', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: format.name, exact: true }).click();
        await dialog.getByRole('radio', { name: format.builderLabel + ' ' + format.file, exact: true }).check();
        await dialog.getByRole('button', { name: 'Create app', exact: true }).click();
      }
      const offlineNotice = format.id === 'jsx' ? 'JSX is ready to edit offline.' : 'Vue components are ready to edit offline.';
      await expect(page.getByText(offlineNotice, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      const counter = (p: Page) => textIn(p, '#value');
      await expect.poll(() => counter(page), { timeout: 60_000 }).toBe('0');
      const first = await exportProject(page, editor, info, 'first');
      await expect.poll(async () => {
        const stored = new Set(await cachedPaths(page));
        return own.every(path => stored.has(path));
      }).toBe(true);
      expect(unused.filter(path => offlineSite.requestedPaths.has(path))).toEqual([]);
      const original = strFromU8(unzipSync(new Uint8Array(first.bytes))[format.file]);
      const source = original.replace(' + 1)', ' + 4)');
      expect(source).not.toBe(original);

      const recipient = await browser.newContext({ baseURL: offlineSite.origin });
      try {
        // A recipient's Runtime has its own empty storage. Give it only the initial export.
        const runtime = await recipient.newPage();
        await keepShadowRoots(runtime);
        await openBundle(runtime, first.name, first.bytes);
        await expect.poll(() => counter(runtime), { timeout: 60_000 }).toBe('0');
        await runtime.locator('.softn-frame-home').first().click();
        await expect(runtime.getByRole('button', { name: 'Open ' + format.app, exact: true }))
          .toHaveAccessibleDescription(/Lite JavaScript.*Offline ready/i, { timeout: 60_000 });

        offlineSite.disconnect();
        if (editor === 'builder') {
          const restore = page.getByRole('button', { name: 'Not now', exact: true });
          await page.addLocatorHandler(restore, () => restore.click());
        }
        await page.reload();
        if (editor === 'builder') {
          const chooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: 'Open', exact: true }).click();
          await (await chooser).setFiles({ name: first.name, mimeType: 'application/zip', buffer: first.bytes });
          await page.getByRole('button', { name: 'Code', exact: true }).click();
        } else {
          await page.getByRole('button', { name: 'Edit ' + format.file, exact: true }).click();
        }
        const field = page.getByRole('textbox', { name: 'Edit ' + format.file, exact: true });
        await expect(field).toHaveValue(original);
        await field.fill(source);
        await page.getByRole('button', { name: editor === 'builder' ? 'Preview' : 'Save & preview', exact: true }).click();
        await expect.poll(() => counter(page), { timeout: 60_000 }).toBe('0');
        await clickIn(page, '#increment');
        await expect.poll(() => counter(page)).toBe('4');
        const edited = await exportProject(page, editor, info, 'edited');
        expect(strFromU8(unzipSync(new Uint8Array(edited.bytes))[format.file])).toBe(source);
        await openBundle(runtime, edited.name, edited.bytes);
        await expect.poll(() => counter(runtime), { timeout: 60_000 }).toBe('0');
        await clickIn(runtime, '#increment');
        await expect.poll(() => counter(runtime)).toBe('4');
        const runtimeCache = new Set(await cachedPaths(runtime));
        expect([...own, ...unused].filter(path => runtimeCache.has(path))).toEqual([]);
      } finally {
        await recipient.close();
      }
    });
  }
}
