// Capture the real checked-in Fieldnotes app, using disposable browser storage.
// Start `npm run dev` first; BUILDER_URL and RUNTIME_URL can override port 1420.
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const output = new URL('./', import.meta.url);
const bundle = await readFile(new URL('../../apps/softn-site/public/examples/Fieldnotes.softn', output));
const builderUrl = process.env.BUILDER_URL || 'http://localhost:1420/builder/';
const runtimeUrl = process.env.RUNTIME_URL || 'http://localhost:1420/web/';
const fixturePath = '/__readme_fieldnotes.softn';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5,
  colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block',
});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route(url => url.pathname === fixturePath,
  route => route.fulfill({ body: bundle, contentType: 'application/zip' }));
await mkdir(output, { recursive: true });
const capture = async (page, name) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: fileURLToPath(new URL(name, output)), type: 'jpeg', quality: 90, animations: 'disabled' });
};

try {
  const builder = await context.newPage();
  await builder.goto(`${builderUrl}?open=${encodeURIComponent(fixturePath)}`);
  await expect(builder.getByText('Fieldnotes', { exact: true }).first()).toBeVisible();
  await builder.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = builder.frameLocator('iframe[title="Device Preview"]');
  await expect(preview.getByLabel('Total tasks', { exact: true })).toHaveText('5');
  await expect(preview.locator('.fn')).toHaveCSS('background-color', 'rgb(246, 245, 241)');
  await expect(builder.getByText('Opened: Fieldnotes v1.0.0', { exact: true })).toBeHidden();
  await preview.getByLabel('Task name', { exact: true }).fill('Plan the next release');
  await capture(builder, 'builder-preview.jpg');

  // Exercise the actual handler before showing the source collection. Preview
  // interaction changes its own records, while Data still holds the five seeds.
  await preview.getByRole('button', { name: /Add task/ }).click();
  await expect(preview.getByLabel('Total tasks', { exact: true })).toHaveText('6');
  await preview.getByRole('button', { name: 'Complete Plan the next release', exact: true }).click();
  await expect(preview.getByLabel('Completed tasks', { exact: true })).toHaveText('3');
  await builder.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(builder.locator('table tbody tr')).toHaveCount(5);
  await builder.setViewportSize({ width: 1440, height: 1000 });
  await capture(builder, 'builder-data.jpg');

  const runtime = await context.newPage();
  await runtime.setViewportSize({ width: 1440, height: 1000 });
  await runtime.goto(`${runtimeUrl}?open=${encodeURIComponent(fixturePath)}`);
  await expect(runtime.getByLabel('Total tasks', { exact: true })).toHaveText('5');
  await runtime.getByRole('button', { name: 'Back to the runtime. The app keeps running.', exact: true }).click();
  await runtime.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await runtime.getByRole('region', { name: 'Running now', exact: true }).getByRole('button', { name: 'Fieldnotes', exact: true }).click();
  await expect(runtime.locator('.fn')).toHaveCSS('background-color', 'rgb(23, 32, 25)');
  await capture(runtime, 'app-dark.jpg');

  await runtime.setViewportSize({ width: 390, height: 844 });
  await runtime.getByRole('button', { name: 'Hide the app bar', exact: true }).click();
  await expect(runtime.getByRole('heading', { name: 'Make space for what matters.', exact: true })).toBeVisible();
  expect(await runtime.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await capture(runtime, 'app-mobile.jpg');
  await runtime.getByLabel('Task name', { exact: true }).fill('Take Fieldnotes with you');
  await runtime.getByRole('button', { name: /Add task/ }).click();
  await expect(runtime.getByRole('button', { name: 'Complete Take Fieldnotes with you', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('Captured Builder preview, collection data, dark runtime and mobile screenshots; real task creation/completion and preview isolation passed.');
} finally {
  await browser.close();
}
