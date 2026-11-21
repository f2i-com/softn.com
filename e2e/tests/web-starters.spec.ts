import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { expect, type Page } from '@playwright/test';
import { test } from '../helpers/offlineSite';
import { clickIn, keepShadowRoots, openBundle, seeIn, textIn } from '../helpers/container';
import { cachedWasm, fullEngine, liteEngine, requestedWasm } from '../helpers/engines';
import { BUILDER_EXPORT_DIALOG } from '../helpers/editors';

async function increment(page: Page, from: number, step = 1) {
  const value = () => textIn(page, '#value');
  await expect.poll(value, { timeout: 60_000 }).toBe(String(from));
  await expect(page.locator('.softn-runner-loading')).toBeHidden();
  await clickIn(page, '#increment');
  await expect.poll(value).toBe(String(from + step));
}

// Change the actual component handler and the stylesheet, using the same controls
// a creator uses. A build artifact or stale preview would still advance by one.
async function editStarter(page: Page, editor: string) {
  const studio = editor === 'studio';
  if (studio) await page.getByRole('button', { name: 'Edit app.js', exact: true }).click();
  else await page.getByRole('button', { name: 'Code', exact: true }).click();
  const script = page.getByRole('textbox', { name: 'Edit app.js', exact: true });
  const original = await script.inputValue();
  const source = original.replace(' + 1)', ' + 3)');
  expect(source).not.toBe(original);
  await script.fill(source);
  if (studio) {
    await page.getByRole('button', { name: 'Save & preview', exact: true }).click();
    await expect.poll(() => textIn(page, '#value')).toBe('0');
    await page.getByRole('treeitem', { name: /^styles\.css,/ }).click();
    await page.getByRole('button', { name: 'Edit styles.css by hand' }).click();
  } else {
    await page.getByRole('tab', { name: /styles\.css/ }).click();
  }
  const styles = page.getByRole('textbox', { name: 'Edit styles.css', exact: true });
  const css = (await styles.inputValue()) + '\n#value { color: rgb(16, 123, 91); }\n';
  await styles.fill(css);
  await page.getByRole('button', { name: studio ? 'Save & preview' : 'Preview', exact: true }).click();
  return { source, css };
}

for (const editor of ['studio', 'builder']) {
  for (const [framework, name] of [['Vanilla JS', 'Trail log'], ['React', 'Practice set'], ['Vue', 'Reading log']]) {
    test(`${editor} edits a ${framework} starter's source and previews the same app offline in Runtime`, async ({ page, browser, request, offlineSite }, testInfo) => {
      test.setTimeout(150_000);
      await keepShadowRoots(page);
      const scope = offlineSite.origin + '/' + editor + '/';
      const sw = await (await request.get(scope + 'sw.js')).text();
      const config = JSON.parse(/^self\.__SOFTN_SW__=(.+);$/m.exec(sw)![1]);
      const compilers = (Object.values(config.sourceCompilers).flat() as string[]).map(url => new URL(url, scope).pathname);
      await page.goto(scope);
      if (editor === 'studio') {
        await page.getByRole('button', { name: `Create ${framework} starter`, exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'New', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: framework, exact: true }).click();
        await dialog.getByRole('button', { name: 'Create app', exact: true }).click();
      }
      await increment(page, 0);
      const { source, css } = await editStarter(page, editor);
      const color = (target: Page) => seeIn(target, '#value').then((el) => el?.color);
      await expect.poll(() => color(page)).toBe('rgb(16, 123, 91)');
      await increment(page, 0, 3);
      if (editor === 'builder') await page.getByRole('button', { name: 'Export', exact: true }).click();
      const exportButton = editor === 'studio'
        ? page.getByRole('button', { name: 'Export bundle', exact: true })
        : page.getByRole('dialog', { name: BUILDER_EXPORT_DIALOG }).getByRole('button', { name: 'Export .softn', exact: true });
      const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
      const file = testInfo.outputPath('starter.softn');
      await download.saveAs(file);
      const archive = await readFile(file);
      const files = unzipSync(new Uint8Array(archive));
      expect(strFromU8(files['app.js'])).toBe(source);
      expect(strFromU8(files['styles.css'])).toBe(css);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      expect(compilers.filter(path => offlineSite.requestedPaths.has(path))).toEqual([]);

      // Give the recipient a clean browser. An editor's installed service
      // worker, storage or precached vendor files cannot help this Runtime.
      const recipient = await browser.newContext({ baseURL: offlineSite.origin });
      try {
        const wasm = requestedWasm(recipient);
        const runtime = await recipient.newPage();
        await keepShadowRoots(runtime);
        await openBundle(runtime, download.suggestedFilename(), archive);
        await increment(runtime, 0, 3);
        await runtime.locator('.softn-frame-home').first().click();
        const card = runtime.getByRole('button', { name: `Open ${name}`, exact: true });
        await expect(card).toHaveAccessibleDescription(/Web app.*Lite JavaScript.*Offline ready/i, { timeout: 60_000 });
        const engines = (await cachedWasm(runtime)).filter(path => /\/zipp[-_]/.test(path));
        expect(engines).toEqual([expect.stringMatching(liteEngine)]);

        offlineSite.disconnect();
        await runtime.reload();
        await card.click();
        await expect.poll(() => color(runtime), { timeout: 60_000 }).toBe('rgb(16, 123, 91)');
        await increment(runtime, 3, 3);
        expect([...wasm].filter(path => fullEngine.test(path))).toEqual([]);
      } finally {
        await recipient.close();
      }
    });
  }
}
