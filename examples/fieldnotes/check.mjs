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
page.on('pageerror', error => {
  errors.push(error.message);
  console.error('Browser page error:', { message: error.message, stack: error.stack, url: page.url() });
});
await page.route(url => url.pathname === '/__fieldnotes_example.softn', route => route.fulfill({ body: bytes, contentType: 'application/zip' }));
const openUrl = base => `${base}?open=${encodeURIComponent('/__fieldnotes_example.softn')}`;
const count = (frame, label) => frame.getByLabel(label, { exact: true }).innerText();
const screenshot = async name => {
  if (!capture) return;
  await mkdir(assets, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(name, assets)), animations: 'disabled' });
};
const saveBundle = async () => {
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const stream = await (await downloadEvent).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
};

try {
  await page.goto(openUrl(builderUrl));
  await page.getByText('Fieldnotes', { exact: true }).first().waitFor();
  assert.equal(await page.locator('[data-fidelity="source-only"]').count(), 0);
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
  const exported = unzipSync(await saveBundle());
  for (const path of ['ui/main.ui', 'logic/main.logic']) assert.equal(strFromU8(exported[path]), strFromU8(sourceEntries[path]));
  const taskFile = JSON.parse(strFromU8(exported['xdb/tasks.xdb']));
  assert.equal(taskFile.records.length, 5);
  assert.equal(taskFile.records[0].id, 'fieldnotes-task-1');
  assert.equal(taskFile.records[0].data.title, 'Sketch the welcome screen');
  assert.equal(taskFile.schema.fields.length, 3);

  // An app advertised as editable must support a real inspector edit, not
  // merely load into the canvas while silently discarding that edit on save.
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Select h1 component', exact: true }).click();
  await page.getByLabel('Text Content', { exact: true }).fill('Make room for your next idea.');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await preview.getByRole('heading', { name: 'Make room for your next idea.', exact: true }).waitFor();
  const visuallyEditedBundle = await saveBundle();
  const editedEntries = unzipSync(visuallyEditedBundle);
  assert.ok(strFromU8(editedEntries['ui/main.ui']).includes('Make room for your next idea.'));
  assert.equal(strFromU8(editedEntries['logic/main.logic']), strFromU8(sourceEntries['logic/main.logic']));
  assert.deepEqual(JSON.parse(strFromU8(editedEntries['xdb/tasks.xdb'])), taskFile);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Preview app', exact: true }).click();
  await preview.getByRole('button', { name: 'Complete Sketch the welcome screen' }).waitFor();
  for (const frame of page.frames()) assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  // Run the visually edited export, not just the original demo. Its records
  // and task actions must remain functional after Builder regenerates its UI.
  await page.route(url => url.pathname === '/__fieldnotes_edited.softn', route => route.fulfill({ body: Buffer.from(visuallyEditedBundle), contentType: 'application/zip' }));
  await page.goto(`${runtimeUrl}?open=${encodeURIComponent('/__fieldnotes_edited.softn')}`);
  await page.getByRole('heading', { name: 'Make room for your next idea.', exact: true }).waitFor();
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
  console.log('Fieldnotes passed: seed data, isolated interactive preview, Data edits, source/schema export, visual heading edit, edited bundle runtime, mobile, validation, create/complete/filter and persisted runtime reload.');
} catch (error) {
  console.error('Page at failure:', page.url());
  console.error('Visible page:', await page.locator('body').innerText().catch(() => '(unavailable)'));
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
