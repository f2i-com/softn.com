// Exercise the actual Builder and Runtime with disposable browser storage.
// PLAYWRIGHT_MODULE can point at an existing Playwright installation.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../../', import.meta.url);
const bytes = await readFile(new URL('apps/softn-site/public/examples/Fieldnotes.softn', root));
const sourceEntries = unzipSync(bytes);
const builderUrl = process.env.BUILDER_URL || 'http://localhost:1420/builder/';
const runtimeUrl = process.env.RUNTIME_URL || 'http://localhost:1420/web/';
const assets = new URL('apps/softn-site/src/assets/', root);
const capture = process.argv.includes('--capture');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1.5 });
// Exercise the supported browser-download save path without a native OS picker.
await context.addInitScript(() => { delete window.showSaveFilePicker; });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(url => url.pathname === '/__fieldnotes_example.softn', route => route.fulfill({ body: bytes, contentType: 'application/zip' }));
const openUrl = base => `${base}?open=${encodeURIComponent('/__fieldnotes_example.softn')}`;
const count = (frame, label) => frame.getByLabel(label, { exact: true }).innerText();
const screenshot = async name => {
  if (!capture) return;
  await mkdir(assets, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(name, assets)), animations: 'disabled' });
};

try {
  await page.goto(openUrl(builderUrl));
  await page.getByText('Fieldnotes', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.frameLocator('iframe');
  await preview.getByRole('button', { name: 'Complete Sketch the welcome screen' }).waitFor();
  assert.equal(await count(preview, 'Total tasks'), '5');
  // Allow transient open notification to disappear before the documentation capture.
  await page.getByText('Opened: Fieldnotes v1.0.0', { exact: true }).waitFor({ state: 'hidden' });
  await screenshot('workspace-preview.png');
  await preview.getByLabel('Task name', { exact: true }).fill('Only in this preview');
  await preview.getByRole('button', { name: 'Add task' }).click();
  await preview.getByRole('button', { name: 'Complete Only in this preview' }).waitFor();
  assert.equal(await count(preview, 'Total tasks'), '6');
  await preview.getByRole('button', { name: 'Complete Only in this preview' }).click();
  await preview.getByRole('button', { name: 'Reopen Only in this preview' }).waitFor();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  assert.equal(await page.locator('input').evaluateAll(inputs => inputs.some(input => input.value === 'Only in this preview')), false);
  assert.equal(await page.locator('table tbody tr').count(), 5);
  await screenshot('workspace-data.png');
  const firstTitle = page.locator('table tbody tr').first().locator('input[type=text]').first();
  await firstTitle.fill('Edited in Data');
  await firstTitle.blur();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await preview.getByRole('button', { name: 'Complete Edited in Data' }).waitFor();
  assert.equal(await count(preview, 'Total tasks'), '5');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await firstTitle.fill('Sketch the welcome screen');
  await firstTitle.blur();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const stream = await (await downloadEvent).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const exported = unzipSync(new Uint8Array(Buffer.concat(chunks)));
  for (const path of ['ui/main.ui', 'logic/main.logic']) assert.equal(strFromU8(exported[path]), strFromU8(sourceEntries[path]));
  const taskFile = JSON.parse(strFromU8(exported['xdb/tasks.xdb']));
  assert.equal(taskFile.records.length, 5);
  assert.equal(taskFile.records[0].id, 'fieldnotes-task-1');
  assert.equal(taskFile.records[0].data.title, 'Sketch the welcome screen');
  assert.equal(taskFile.schema.fields.length, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Preview app', exact: true }).click();
  await preview.getByRole('button', { name: 'Complete Sketch the welcome screen' }).waitFor();
  for (const frame of page.frames()) assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  // A distinct runtime session persists its own records through reload.
  await page.goto(openUrl(runtimeUrl));
  await page.getByRole('button', { name: 'Complete Sketch the welcome screen' }).waitFor();
  await page.getByRole('button', { name: 'Add task' }).click();
  assert.equal(await page.getByRole('alert').innerText(), 'Give your task a name first.');
  await page.getByLabel('Task name', { exact: true }).fill('Try the complete flow');
  await page.getByLabel('Focus', { exact: true }).selectOption('Review');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByRole('button', { name: 'Complete Try the complete flow' }).click();
  await page.getByRole('button', { name: 'Reopen Try the complete flow' }).waitFor();
  assert.equal(await count(page, 'Total tasks'), '6');
  assert.equal(await count(page, 'Completed tasks'), '3');
  await page.reload();
  await page.getByRole('button', { name: 'Reopen Try the complete flow' }).waitFor();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  assert.equal(await page.getByText('Try the complete flow', { exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log('Fieldnotes passed: seed data, isolated interactive preview, Data edits, source/schema export, mobile, validation, create/complete/filter and persisted runtime reload.');
} finally {
  await browser.close();
}
