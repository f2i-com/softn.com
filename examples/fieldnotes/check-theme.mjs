// Verify the shipped app's appearance, a live host toggle and portrait scrolling.
// Uses the existing dev/deployment server and disposable browser storage.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../../', import.meta.url);
const bytes = await readFile(new URL('apps/softn-site/public/examples/Fieldnotes.softn', root));
const runtimeUrl = process.env.RUNTIME_URL || 'http://localhost:1420/web/';
const capture = process.argv.includes('--capture');
const output = new URL('../ecosystem-audit/', root);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(url => url.pathname === '/__fieldnotes_theme.softn', route => route.fulfill({ body: bytes, contentType: 'application/zip' }));

function luminance(color) {
  const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

async function checkPalette(mode) {
  await page.locator(`.softn-theme-${mode} .fn`).waitFor();
  const palette = await page.locator('.fn').evaluate(app => {
    const styles = selector => getComputedStyle(selector ? app.querySelector(selector) : app);
    const pair = (text, background) => [styles(text).color, styles(background).backgroundColor];
    return {
      background: styles().backgroundColor, inputScheme: styles('input').colorScheme,
      pairs: {
        heading: pair('h1', null), label: pair('.fn-label', null),
        task: pair('.fn-task-title', '.fn-card'), taskHint: pair('.fn-task-copy p', '.fn-card'),
        completed: pair('.fn-task-title.done', '.fn-card'), input: pair('input', 'input'),
        action: pair('.fn-add', '.fn-add'), note: pair('.fn-flow p', '.fn-flow'),
        status: pair('.fn-status', null), error: pair('.fn-error', '.fn-form'),
      },
    };
  });
  assert.equal(palette.background, mode === 'light' ? 'rgb(246, 245, 241)' : 'rgb(23, 32, 25)');
  assert.equal(palette.inputScheme, mode);
  for (const [label, [foreground, background]] of Object.entries(palette.pairs)) {
    assert.ok(contrast(foreground, background) >= 4.5, `${mode} ${label} contrast ${contrast(foreground, background).toFixed(2)} is too low`);
  }
  assert.equal(await page.getByLabel('Total tasks', { exact: true }).innerText(), '5');
  assert.equal(await page.getByLabel('Task name', { exact: true }).inputValue(), 'An unfinished idea');
  if (capture) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`fieldnotes-${mode}.png`, output)), animations: 'disabled' });
  }
}

async function toggleFromHome(mode) {
  await page.getByRole('button', { name: 'Back to the runtime. The app keeps running.', exact: true }).click();
  await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
  await page.getByRole('region', { name: 'Running now', exact: true }).getByRole('button', { name: 'Fieldnotes', exact: true }).click();
}

try {
  await page.goto(`${runtimeUrl}?open=${encodeURIComponent('/__fieldnotes_theme.softn')}`);
  await page.getByRole('heading', { name: 'Make space for what matters.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('Task name', { exact: true }).fill('An unfinished idea');
  await checkPalette('light');
  await toggleFromHome('dark');
  await checkPalette('dark');
  await toggleFromHome('light');
  await checkPalette('light');
  await toggleFromHome('dark');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const app = page.locator('.softn-app');
  assert.equal(await app.evaluate(element => getComputedStyle(element).overflowY), 'auto');
  await page.mouse.move(200, 450);
  await page.mouse.wheel(0, 2400);
  await page.waitForFunction(() => document.querySelector('.softn-app')?.scrollTop > 0);
  const bounds = await page.locator('.fn-status').boundingBox();
  const viewport = await app.boundingBox();
  assert.ok(bounds.y >= viewport.y && bounds.y + bounds.height <= viewport.y + viewport.height + 2, 'the final status is reachable by actual wheel scrolling');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByRole('button', { name: 'Complete An unfinished idea', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Total tasks', { exact: true }).innerText(), '6');
  if (capture) await page.screenshot({ path: fileURLToPath(new URL('fieldnotes-dark-mobile.png', output)), animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Fieldnotes theme passed: warm light and olive dark palettes, text contrast, native input scheme, live host toggle with unsaved input retained, and real portrait scrolling/task creation.');
} catch (error) {
  console.error('Page at failure:', page.url());
  console.error('Visible page:', await page.locator('body').innerText().catch(() => '(unavailable)'));
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
