import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { BUILDER_EXPORT_DIALOG } from '../helpers/editors';
import { test } from '../helpers/offlineSite';
import { clickIn, keepShadowRoots, openBundle, textIn } from '../helpers/container';
import { cachedWasm, liteEngine } from '../helpers/engines';

async function exportFiles(page: Page, info: TestInfo, editor: 'Studio' | 'Builder') {
  if (editor === 'Builder') await page.getByRole('button', { name: 'Export', exact: true }).click();
  const button = editor === 'Studio' ? page.getByRole('button', { name: 'Export bundle', exact: true })
    : page.getByRole('dialog', { name: BUILDER_EXPORT_DIALOG }).getByRole('button', { name: 'Export .softn', exact: true });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const path = info.outputPath(editor + '.softn');
  await download.saveAs(path);
  const files = unzipSync(new Uint8Array(await readFile(path)));
  return { path, read: (name: string) => strFromU8(files[name]), manifest: JSON.parse(strFromU8(files['manifest.json'])) };
}

for (const theme of ['dark', 'light'] as const) {
  test(`Studio database designer keeps a solid surface and visible actions in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize(theme === 'light' ? { width: 390, height: 580 } : { width: 1280, height: 720 });
    await page.addInitScript((choice) => localStorage.setItem('softn.site.theme', choice), theme);
    await page.goto('/studio/');
    await page.getByRole('button', { name: 'Create Vanilla JS starter' }).click();
    const files = page.getByRole('button', { name: 'Files', exact: true });
    await files.waitFor();
    const open = page.getByRole('button', { name: 'Database', exact: true });
    if (!await open.isVisible()) await files.click();
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Design a database' });
    const create = dialog.getByRole('button', { name: 'Create collection' });
    await expect(dialog).toHaveCSS('background-color', /^rgb\(/);
    await expect(create).toHaveCSS('color', /^rgb\(/);
    await expect(dialog.getByLabel('Collection name')).toBeFocused();
    const add = dialog.getByRole('button', { name: 'Add field' });
    for (let i = 2; i <= 9; i++) {
      await add.click();
      await expect(dialog.getByLabel(`Field ${i} name`, { exact: true })).toBeFocused();
    }
    await expect(create).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('heading', { name: 'Design a database' })).toBeInViewport({ ratio: 1 });
    await dialog.getByRole('button', { name: 'Remove field 9' }).click();
    await expect(dialog.getByLabel('Field 8 name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
  });
}

test('design local and shared data in Studio, then edit the same private API in Builder', async ({ page }, info) => {
  await page.goto('/studio/');
  await page.getByRole('button', { name: 'Create Vanilla JS starter', exact: true }).click();
  const filesPanel = page.getByRole('button', { name: 'Files', exact: true });
  if (await filesPanel.getAttribute('aria-pressed') !== 'true') await filesPanel.click();
  for (const target of ['local', 'formlogic'] as const) {
    await page.getByRole('button', { name: 'Database', exact: true }).click();
    const designer = page.getByRole('dialog', { name: 'Design a database' });
    await designer.getByLabel('Storage').selectOption(target);
    await designer.getByLabel(target === 'local' ? 'Collection name' : 'Table name').fill('notes');
    await designer.getByLabel('Field 1 name').fill('title');
    await designer.getByLabel('Required').check();
    await designer.getByRole('button', { name: target === 'local' ? 'Create collection' : 'Create table' }).click();
    await expect(designer).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  let api = page.getByRole('dialog', { name: 'FormLogic backend' });
  await api.getByRole('button', { name: 'Add route' }).click();
  await api.getByLabel('Path', { exact: true }).fill('/api/notes');
  await api.getByLabel('Handler', { exact: true }).fill('listNotes');
  await api.getByLabel('Handler', { exact: true }).press('Enter');
  await expect(api.getByRole('button', { name: 'Add route' })).toBeFocused();
  const source = api.getByRole('textbox', { name: /handler source/i });
  const handler = (await source.inputValue()).replace('status: 501, body: { error: "Handler not implemented" }', 'status: 200, body: { notes: softn.sql.query("SELECT id, title FROM notes", []) }');
  await source.fill(handler);
  await api.getByRole('button', { name: 'Save backend' }).click();
  const studio = await exportFiles(page, info, 'Studio');
  expect(studio.manifest.files.xdb).toContain('xdb/notes.xdb');
  expect(JSON.parse(studio.read('xdb/notes.xdb')).schema.fields[0]).toMatchObject({ name: 'title', required: true });
  const migration = studio.manifest.server.database.migrations[0];
  expect(studio.read(migration)).toContain('"title" TEXT NOT NULL');
  expect(studio.manifest.server.routes).toContainEqual(expect.objectContaining({ handler: 'listNotes', path: '/api/notes' }));

  await page.goto('/builder/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await (await chooser).setFiles(studio.path);
  await page.getByRole('button', { name: 'FormLogic backend', exact: true }).click();
  api = page.getByRole('dialog', { name: 'FormLogic backend' });
  const imported = api.getByRole('textbox', { name: /handler source/i });
  await expect(imported).toHaveValue(handler);
  const changed = handler.replace('SELECT id, title FROM notes', 'SELECT title FROM notes ORDER BY id');
  await imported.fill(changed);
  await api.getByRole('button', { name: 'Save backend' }).click();
  const builder = await exportFiles(page, info, 'Builder');
  expect(builder.read(builder.manifest.server.entry)).toBe(changed);
  expect(builder.read(migration)).toBe(studio.read(migration));
  expect(builder.read('xdb/notes.xdb')).toBe(studio.read('xdb/notes.xdb'));
});

for (const [framework, app] of [['Vanilla JS', 'Trail log'], ['React', 'Practice set'], ['Vue', 'Reading log']]) {
  test(`${framework} reads and updates its local database in a reopened offline Runtime`, async ({ browser, page, offlineSite }, info) => {
    test.setTimeout(120_000);
    await page.goto(offlineSite.origin + '/studio/');
    await page.getByRole('button', { name: `Create ${framework} starter`, exact: true }).click();
    await page.getByRole('button', { name: 'Edit app.js', exact: true }).click();
    const script = page.getByRole('textbox', { name: 'Edit app.js', exact: true });
    const original = await script.inputValue();
    // Keep each starter's own layout and framework rendering. Store its counter as one XDB row.
    const client = original.replace(/localStorage\.getItem\('[a-z]+'\)/, "db.get('stats', 'counter')?.data.value")
      .replace(/localStorage\.setItem\('[a-z]+', String\((\w+)\)\)/, 'saveCounter($1)');
    expect(client).not.toContain('localStorage.');
    await script.fill(`import { db } from 'softn:db';
function saveCounter(value) {
  if (db.get('stats', 'counter')) db.update('counter', { value });
  else db.create('stats', { id: 'counter', value });
}
${client}`);
    await page.getByRole('button', { name: 'Save & preview', exact: true }).click();
    const owner = await exportFiles(page, info, 'Studio');
    const recipient = await browser.newContext({ baseURL: offlineSite.origin });
    try {
      const runtime = await recipient.newPage();
      await keepShadowRoots(runtime);
      await openBundle(runtime, app + '.softn', await readFile(owner.path));
      const value = () => textIn(runtime, '#value');
      const home = runtime.locator('.softn-frame-home').first();
      const card = runtime.getByRole('button', { name: 'Open ' + app, exact: true });
      await expect.poll(value, { timeout: 60_000 }).toBe('0');
      await clickIn(runtime, '#increment');
      await expect.poll(value).toBe('1');
      await home.click();
      await expect(card).toHaveAccessibleDescription(/Lite JavaScript.*Offline ready/i, { timeout: 60_000 });
      offlineSite.disconnect();
      await runtime.reload();
      await card.click();
      await expect.poll(value).toBe('1');
      await clickIn(runtime, '#increment');
      await expect.poll(value).toBe('2');
      await home.click();
      await runtime.reload();
      await card.click();
      await expect.poll(value).toBe('2');
      expect((await cachedWasm(runtime)).filter(path => /\/zipp[-_]/.test(path))).toEqual([expect.stringMatching(liteEngine)]);
    } finally { await recipient.close(); }
  });
}
